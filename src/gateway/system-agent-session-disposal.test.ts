import { describe, expect, it, vi } from "vitest";
import { disposeGatewaySystemAgentSessions } from "./system-agent-session-disposal.js";

describe("disposeGatewaySystemAgentSessions", () => {
  it("waits for every engine before reporting cleanup failures", async () => {
    let releaseSlowEngine: () => void = () => {};
    const slowEngine = new Promise<void>((resolve) => {
      releaseSlowEngine = resolve;
    });
    const failedDispose = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const slowDispose = vi.fn(async () => await slowEngine);
    const sessions = new Map([
      ["failed", { engine: { dispose: failedDispose } }],
      ["slow", { engine: { dispose: slowDispose } }],
    ]);

    const disposal = disposeGatewaySystemAgentSessions(sessions);
    let settled = false;
    void disposal.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(slowDispose).toHaveBeenCalledOnce());
    expect(sessions.size).toBe(0);
    expect(settled).toBe(false);

    releaseSlowEngine();
    await expect(disposal).rejects.toThrow("System-agent session disposal failed");
    expect(failedDispose).toHaveBeenCalledOnce();
  });
});
