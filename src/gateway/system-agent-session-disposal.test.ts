import { describe, expect, it, vi } from "vitest";
import { beginGatewaySystemAgentSessionDisposal } from "./system-agent-session-disposal.js";

describe("beginGatewaySystemAgentSessionDisposal", () => {
  it("waits for every engine before reporting cleanup failures", async () => {
    let releaseSlowEngine: () => void = () => {};
    const slowEngine = new Promise<void>((resolve) => {
      releaseSlowEngine = resolve;
    });
    const failedDispose = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const slowDispose = vi.fn(async () => await slowEngine);
    const finishDisposalForGatewayShutdown = vi.fn(async () => undefined);
    const sessions = new Map([
      [
        "failed",
        {
          engine: {
            beginDisposalForGatewayShutdown: failedDispose,
            finishDisposalForGatewayShutdown,
          },
        },
      ],
      [
        "slow",
        {
          engine: {
            beginDisposalForGatewayShutdown: slowDispose,
            finishDisposalForGatewayShutdown,
          },
        },
      ],
    ]);

    const disposal = beginGatewaySystemAgentSessionDisposal(sessions);
    let settled = false;
    void disposal.drain.then(
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
    await expect(disposal.drain).rejects.toThrow("System-agent session disposal failed");
    expect(failedDispose).toHaveBeenCalledOnce();
  });

  it("finalizes every engine only after the harness shutdown boundary", async () => {
    const neverSettles = new Promise<void>(() => {});
    const dispose = vi.fn(async () => await neverSettles);
    const finishDisposalForGatewayShutdown = vi.fn(async () => undefined);
    const sessions = new Map([
      [
        "blocked",
        {
          engine: {
            beginDisposalForGatewayShutdown: dispose,
            finishDisposalForGatewayShutdown,
          },
        },
      ],
    ]);

    const disposal = beginGatewaySystemAgentSessionDisposal(sessions);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    await disposal.finish();

    expect(finishDisposalForGatewayShutdown).toHaveBeenCalledOnce();
  });
});
