import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import { completeTerminalEffects } from "./subagent-registry-terminal-effects.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn<() => Promise<SubagentKillSession>>(),
}));
vi.mock("./subagent-control-session.js", () => ({
  prepareSubagentKillSession: mocks.prepare,
}));
vi.mock("./subagent-registry-terminal-effects.js", () => ({
  completeTerminalEffects: vi.fn(async () => {}),
}));
vi.mock("../../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: (): OpenClawStateWorkerContext => ({
    admission: {
      coordinationKey: "collector-publication",
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "collector-publication", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  }),
}));

it.for(["unchanged", "session replacement", "run replacement", "execution replacement"] as const)(
  "keeps collector postimages private while joining publication (%s)",
  async (transition, { signal }) => {
    const entry = createRunEntry({
      collect: true,
      expectsCompletionMessage: false,
      delivery: { status: "not_required" },
    });
    const original = structuredClone(entry);
    const execution = entry.execution;
    const delivery = entry.delivery;
    const runs = new Map([[entry.runId, entry]]);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let sessionCurrent = true;
    const assertSession = () => {
      if (!sessionCurrent) {
        throw new Error("Original collector session was replaced");
      }
    };
    const releaseWait = () => release.resolve();
    signal.addEventListener("abort", releaseWait, { once: true });
    const session: SubagentKillSession = {
      storePath: "/synthetic/agent.sqlite",
      entry: { sessionId: "collector-session", updatedAt: 1, inputTokens: 7 },
      assertCurrent: assertSession,
      withPublication: async (publish) => {
        entered.resolve();
        await release.promise;
        assertSession();
        return await publish();
      },
      release: vi.fn(),
    };
    mocks.prepare.mockReset().mockResolvedValue(session);
    vi.mocked(completeTerminalEffects).mockClear();
    const persisted: SubagentRunRecord[] = [];
    const persistOrThrow = vi.fn(() => persisted.push(structuredClone(entry)));
    const controller = createLifecycleControllerFixture(
      { entry, runs, persistOrThrow },
      {
        callGateway: async () => {
          throw new Error("Unexpected collector gateway call");
        },
        cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
        ownersByEntry: new WeakMap<
          SubagentRunRecord,
          Pick<SubagentLifecycleOptions, "runs" | "persistAsyncOrThrow">
        >(),
      },
    );
    const completion = controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      terminalReply: { disposition: "visible", text: "private collector result" },
      triggerCleanup: false,
    });
    const settled = completion.then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        entered.promise,
        settled.then((result) => {
          if ("error" in result) {
            throw result.error;
          }
          throw new Error("Collector skipped publication admission");
        }),
      ]);
      expect(entry).toEqual(original);
      expect(entry.execution).toBe(execution);
      expect(entry.delivery).toBe(delivery);
      expect(persisted).toEqual([]);
      expect(completeTerminalEffects).not.toHaveBeenCalled();
      let successor = entry;
      if (transition === "session replacement") {
        sessionCurrent = false;
      } else if (transition === "run replacement") {
        successor = createRunEntry({ runId: entry.runId });
        runs.set(entry.runId, successor);
      } else if (transition === "execution replacement") {
        entry.execution = { ...execution };
      }
      const successorExecution = successor.execution;
      release.resolve();
      const result = await settled;
      if (transition === "unchanged") {
        expect(result).toEqual({ ok: true });
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({
          execution: { status: "terminal" },
          completion: { resultText: "private collector result" },
          collectorCompletion: { status: "done", usage: { inputTokens: 7, outputTokens: 0 } },
        });
        expect(entry).toEqual(persisted[0]);
        expect(completeTerminalEffects).toHaveBeenCalledOnce();
      } else {
        expect(result).toHaveProperty("error");
        expect(persisted).toEqual([]);
        expect(runs.get(entry.runId)).toBe(successor);
        expect(successor.execution).toBe(successorExecution);
        expect(entry.collectorCompletion).toBeUndefined();
        expect(entry.completion).toBeUndefined();
        expect(completeTerminalEffects).not.toHaveBeenCalled();
      }
      expect(session.release).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await settled;
      signal.removeEventListener("abort", releaseWait);
      controller.clearScheduledResumeTimers();
    }
  },
);
