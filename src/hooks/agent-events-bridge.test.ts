import { afterEach, describe, expect, it, vi } from "vitest";

import { emitAgentEvent } from "../infra/agent-events.js";
import { startAgentEventsHookBridge } from "./agent-events-bridge.js";
import * as internalHooks from "./internal-hooks.js";

describe("agent events hook bridge", () => {
  afterEach(() => {
    internalHooks.clearInternalHooks();
    internalHooks.clearInternalHookListenersForTest();
  });

  it("forwards lifecycle error as agent:error", async () => {
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();
    const unsub = startAgentEventsHookBridge({
      enabled: true,
      includeSensitiveHookContext: true,
      includeErrorStack: true,
    });

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "error", error: "boom", stack: "stacktrace" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent",
        action: "error",
      }),
    );
    const event = spy.mock.calls[0]?.[0] as internalHooks.InternalHookEvent;
    expect(event.context).toMatchObject({ message: "boom", stack: "stacktrace" });

    unsub?.();
    spy.mockRestore();
  });

  it("omits stacks unless includeErrorStack is enabled", async () => {
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();
    const unsub = startAgentEventsHookBridge({
      enabled: true,
      includeSensitiveHookContext: true,
    });

    emitAgentEvent({
      runId: "run-1b",
      stream: "lifecycle",
      data: { phase: "error", error: "boom", stack: "stacktrace" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = spy.mock.calls[0]?.[0] as internalHooks.InternalHookEvent;
    expect((event.context as Record<string, unknown>).stack).toBeUndefined();

    unsub?.();
    spy.mockRestore();
  });

  it("redacts lifecycle error details by default", async () => {
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();
    const unsub = startAgentEventsHookBridge({ enabled: true });

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: { phase: "error", error: "boom" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = spy.mock.calls[0]?.[0] as internalHooks.InternalHookEvent;
    expect(event.context).toMatchObject({ hasErrorMessage: true });
    expect((event.context as Record<string, unknown>).message).toBeUndefined();
    expect((event.context as Record<string, unknown>).data).toBeUndefined();

    unsub?.();
    spy.mockRestore();
  });
});
