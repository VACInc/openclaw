import { describe, expect, it, vi } from "vitest";

import * as config from "../config/config.js";
import { createAgentEventHandler, createChatRunState } from "./server-chat.js";

describe("agent event handler", () => {
  it("emits chat delta for assistant text-only events", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("redacts lifecycle stacks from broadcast by default", () => {
    const loadConfigSpy = vi.spyOn(config, "loadConfig").mockReturnValue({
      hooks: { internal: { includeErrorStack: false } },
    });
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "boom", stack: "stacktrace" },
    });

    const agentCall = broadcast.mock.calls.find(([event]) => event === "agent");
    expect(agentCall).toBeTruthy();
    const payload = agentCall?.[1] as { data?: Record<string, unknown> };
    expect(payload?.data?.stack).toBeUndefined();
    loadConfigSpy.mockRestore();
  });

  it("includes lifecycle stacks when includeErrorStack is enabled", () => {
    const loadConfigSpy = vi.spyOn(config, "loadConfig").mockReturnValue({
      hooks: { internal: { includeErrorStack: true } },
    });
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-3",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "boom", stack: "stacktrace" },
    });

    const agentCall = broadcast.mock.calls.find(([event]) => event === "agent");
    expect(agentCall).toBeTruthy();
    const payload = agentCall?.[1] as { data?: Record<string, unknown> };
    expect(payload?.data?.stack).toBe("stacktrace");
    loadConfigSpy.mockRestore();
  });
});
