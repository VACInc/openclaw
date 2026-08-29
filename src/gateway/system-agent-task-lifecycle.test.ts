import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  beginGatewaySystemAgentTaskShutdown,
  runSystemAgentTask,
} from "./system-agent-task-lifecycle.js";

afterEach(() => {
  resetCommandQueueStateForTest();
});

describe("Gateway system-agent task lifecycle", () => {
  it("rejects accepted queued work before it can start after shutdown sealing", async () => {
    const owner = {};
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    let queuedTaskStarted = false;
    const first = runSystemAgentTask(owner, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const queued = runSystemAgentTask(owner, async () => {
      queuedTaskStarted = true;
    });

    const drained = beginGatewaySystemAgentTaskShutdown(owner);
    releaseFirst.resolve();

    await first;
    await expect(queued).rejects.toThrow("Gateway is draining");
    await drained;
    expect(queuedTaskStarted).toBe(false);
  });

  it("rejects new work as soon as shutdown seals the owner", async () => {
    const owner = {};
    await beginGatewaySystemAgentTaskShutdown(owner);

    await expect(runSystemAgentTask(owner, async () => undefined)).rejects.toThrow(
      "Gateway is draining",
    );
  });
});
