import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, vi, type TestContext } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import type { ExecApprovalManagerOptions } from "./exec-approval-manager.types.js";
import * as operatorApprovalStore from "./operator-approval-store.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";

type TestApprovalRequestOwner = Pick<ExecApprovalManager<unknown>, "drain">;
const pendingRequests = new WeakMap<TestApprovalRequestOwner, Set<Promise<unknown>>>();

/** Observe an actual request publication and retain its operation through fixture teardown. */
export async function waitForTestApprovalRequest(
  manager: TestApprovalRequestOwner,
  operation: Promise<unknown> | void,
  published: Promise<unknown>,
): Promise<void> {
  const pending = Promise.resolve(operation);
  let requests = pendingRequests.get(manager);
  if (!requests) {
    requests = new Set();
    pendingRequests.set(manager, requests);
  }
  requests.add(pending);
  await Promise.race([
    published,
    pending.then(() => {
      throw new Error("Approval request completed before its publication");
    }),
  ]);
}

/** Retirement closes observers; join their request promises before removing database inputs. */
export async function drainTestApprovalRequests(manager: TestApprovalRequestOwner): Promise<void> {
  await manager.drain();
  const requests = pendingRequests.get(manager);
  if (requests) {
    // The test observes operation errors. Cleanup also observes retirement rejection
    // when a failed assertion prevents the test from reaching its decision await.
    await Promise.allSettled(requests);
    pendingRequests.delete(manager);
  }
}

/** RPC acceptance is emitted only after durable registration and route preparation. */
export function startTestApprovalRpcRequest(
  manager: TestApprovalRequestOwner,
  handler: GatewayRequestHandler,
  opts: GatewayRequestHandlerOptions,
): { pending: Promise<void>; ready: Promise<void> } {
  const responseSent = createDeferredCore();
  vi.mocked(opts.respond).mockImplementation(() => responseSent.resolve());
  const pending = Promise.resolve(handler(opts));
  const ready = waitForTestApprovalRequest(manager, pending, responseSent.promise).then(() => {
    expect(opts.context.logGateway.error).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "accepted", id: expect.any(String) }),
      undefined,
    );
  });
  return { pending, ready };
}

/** Vitest clocks are process-local; send controlled time through the store's existing input. */
export function installTestApprovalClock(): (() => void) | undefined {
  const forceDeny = operatorApprovalStore.forceDenyOperatorApproval;
  if (vi.isMockFunction(forceDeny)) {
    return undefined;
  }
  const spy = vi
    .spyOn(operatorApprovalStore, "forceDenyOperatorApproval")
    .mockImplementation((params) => {
      if (params.nowMs === undefined && (vi.isFakeTimers() || vi.isMockFunction(Date.now))) {
        return forceDeny({ ...params, nowMs: Date.now() });
      }
      return forceDeny(params);
    });
  return () => spy.mockRestore();
}

/** Each manager owns a real store, including when two managers reuse an approval id. */
export function createTestApprovalManager<TPayload = ExecApprovalRequestPayload>(
  test: TestContext,
  options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence"> = {},
): ExecApprovalManager<TPayload> {
  test.signal.throwIfAborted();
  const restoreClock = installTestApprovalClock();
  test.onTestFinished(() => restoreClock?.());
  const fixture = createFixtureLifetime();
  let manager: ExecApprovalManager<TPayload> | undefined;
  let databasePath: string | undefined = undefined;
  // Register on the actual test, never once through a cached helper module.
  test.onTestFinished(() => {
    void fixture.verifyCleanup(async () => {
      if (manager) {
        await drainTestApprovalRequests(manager);
      }
      if (databasePath) {
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
      }
    });
    return fixture.cleanup();
  });
  const root = fixture.createTempDir("openclaw-test-approval-");
  databasePath = path.join(root, "state.sqlite");
  const databaseOptions = {
    path: databasePath,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  };
  // Schema setup precedes the request's existing deadline, as at Gateway startup.
  try {
    openOpenClawStateDatabase(databaseOptions);
    manager = new ExecApprovalManager<TPayload>({
      ...options,
      persistence: { runtimeEpoch: randomUUID(), databaseOptions },
    });
    return manager;
  } catch (error) {
    // A failed open can include failed closure of an unpublished handle.
    // Retain its inputs rather than certify cleanup from an empty cache.
    void fixture.track(
      Promise.reject(new Error("Approval fixture initialization failed", { cause: error })),
      true,
    );
    throw error;
  }
}
