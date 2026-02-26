import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";

const mockedEnqueueCommandInLane = vi.mocked(enqueueCommandInLane);

describe("runEmbeddedPiAgent read-only command lane routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: null }));
  });

  it("bypasses the session lane for read-only slash commands", async () => {
    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt: "/status",
    });

    expect(mockedEnqueueCommandInLane).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueCommandInLane.mock.calls[0]?.[0]).toBe("main");
  });

  it("keeps session lane queueing for mutating slash commands", async () => {
    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt: "/verbose on",
    });

    expect(mockedEnqueueCommandInLane).toHaveBeenCalledTimes(2);
    expect(mockedEnqueueCommandInLane.mock.calls[0]?.[0]).toBe("session:test-key");
    expect(mockedEnqueueCommandInLane.mock.calls[1]?.[0]).toBe("main");
  });

  it("treats no-arg mode queries as read-only", async () => {
    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      prompt: "/thinking",
    });

    expect(mockedEnqueueCommandInLane).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueCommandInLane.mock.calls[0]?.[0]).toBe("main");
  });
});
