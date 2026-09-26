import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  binding: {
    pluginId: "a",
    toolName: "render",
    childSessionKey: "agent:main:subagent:child",
    childSessionId: "session-original",
    childRunId: "run-original",
    childCreatedAt: 1,
    status: "pending",
  },
  runId: "run-original",
  sessionId: "session-original",
  status: "running",
  closed: false,
  commands: [] as string[],
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/sessions.js", () => ({ resolveSessionStorePathCore: () => "fixture" }));
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    _scope: unknown,
    check: () => void,
    consume: (r: unknown) => Promise<unknown>,
  ) => {
    check();
    return consume({ ok: true, value: { sessionId: state.sessionId } });
  },
}));
vi.mock("./subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: () => ({
    runId: state.runId,
    collect: false,
    createdAt: 1,
    execution: { status: state.status },
  }),
}));
vi.mock("./plugin-async-callback.js", () => ({
  runPluginAsyncCallbackCommand: async (
    command: { type: string; input: { binding?: typeof state.binding } },
    guard: (binding: typeof state.binding) => void,
  ) => {
    state.commands.push(command.type);
    if (command.type === "pluginCallback.lookup") {
      return state.binding;
    }
    guard(command.input.binding!);
    if (command.type === "pluginCallback.issue") {
      return { token: "private-token", expiresAt: 1000, queueId: "expiry" };
    }
    return { status: "accepted" };
  },
}));
vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContext: () => ({
    sessionKey: state.binding.childSessionKey,
    sessionId: state.sessionId,
    agentId: "main",
  }),
}));
import {
  issueHostPluginAsyncCallback,
  completeHostPluginAsyncCallback,
} from "./plugin-async-callback.host.js";

beforeEach(() => {
  state.binding.pluginId = "a";
  state.runId = "run-original";
  state.sessionId = "session-original";
  state.status = "running";
  state.closed = false;
  state.commands.length = 0;
});

function complete(pluginId: string) {
  return completeHostPluginAsyncCallback({
    pluginId,
    token: "secret-token",
    resultText: "result",
    assertPluginCurrent: () => {
      if (state.closed) {
        throw new Error("plugin generation retired");
      }
    },
  });
}

it("accepts a new live invocation, but not another plugin or retired generation", async () => {
  expect(await complete("a")).toBe("accepted");
  expect(await complete("b")).toBe("unknown");
  expect(state.commands).toEqual([
    "pluginCallback.lookup",
    "pluginCallback.complete",
    "pluginCallback.lookup",
  ]);
  state.closed = true;
  await expect(complete("a")).rejects.toThrow("generation retired");
});

it.each([
  ["session reset", { sessionId: "session-reset" }],
  ["child replaced", { runId: "run-replaced" }],
  ["child cancelled", { status: "cancelled" }],
])("refuses %s before the worker completion claim", async (_name, change) => {
  Object.assign(state, change);
  await expect(complete("a")).rejects.toThrow("no longer current");
  expect(state.commands).toEqual(["pluginCallback.lookup"]);
});

it("issues during a running tool invocation rather than requiring an already paused child", async () => {
  const handle = await issueHostPluginAsyncCallback({
    pluginId: "a",
    toolName: "render",
    runId: "execution",
    agentId: "main",
    sessionKey: state.binding.childSessionKey,
    sessionId: state.sessionId,
    ttlMs: 1000,
    assertInvocationCurrent: () => {},
    assertPluginCurrent: () => {},
  });
  expect(handle.token).toBe("private-token");
  expect(state.commands).toEqual(["pluginCallback.issue"]);
});
