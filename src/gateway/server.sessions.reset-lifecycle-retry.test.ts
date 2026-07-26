// Session reset lifecycle retry tests protect generation identity across
// partial failures that occur after harness cleanup.
import { afterEach, expect, test } from "vitest";
import {
  listRegisteredAgentHarnesses,
  registerAgentHarness,
  restoreRegisteredAgentHarnesses,
} from "../agents/harness/registry.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, testState } from "./test-helpers.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { seedActiveMainSession } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("sessions.reset reuses a legacy cleanup revision after a partial failure", async () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  const lifecycleRevisions: Array<string | undefined> = [];
  let cleanupObserved = false;
  registerAgentHarness({
    id: "reset-retry-observer",
    label: "Reset retry observer",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    reset: async (params) => {
      lifecycleRevisions.push(params.lifecycleRevision);
      cleanupObserved = true;
    },
  });
  try {
    await seedActiveMainSession();
    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", true);
    const { performGatewaySessionReset } = await import("./session-reset-service.js");

    await expect(
      performGatewaySessionReset({
        key: "main",
        reason: "reset",
        commandSource: "gateway:agent",
        assertAuthorizedInstance: () => {
          if (cleanupObserved) {
            cleanupObserved = false;
            throw new Error("partial reset after harness cleanup");
          }
        },
      }),
    ).rejects.toThrow("partial reset after harness cleanup");
    const storePath = testState.sessionStorePath;
    if (!storePath) {
      throw new Error("expected session store path");
    }
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath,
      })?.lifecycleRevision,
    ).toBeUndefined();

    const retry = await performGatewaySessionReset({
      key: "main",
      reason: "reset",
      commandSource: "gateway:agent",
    });

    expect(retry.ok).toBe(true);
    expect(lifecycleRevisions).toEqual(["legacy:sess-main", "legacy:sess-main"]);
  } finally {
    restoreRegisteredAgentHarnesses(registeredHarnesses);
  }
});
