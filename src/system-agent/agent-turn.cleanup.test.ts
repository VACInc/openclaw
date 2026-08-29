import { describe, expect, it, vi } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { cleanupSystemAgentSession, createSystemAgentSession } from "./agent-turn.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

describe("cleanupSystemAgentSession", () => {
  it("deletes the ephemeral harness binding", async () => {
    const verifiedInference = {} as SystemAgentVerifiedInferenceBinding;
    const session = createSystemAgentSession(verifiedInference);
    session.bindingSessionKey = null;
    const commit = vi.fn();
    const rollback = vi.fn();
    const deletionParams: unknown[] = [];

    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      registerAgentHarness({
        id: "system-agent-cleanup-test",
        label: "System agent cleanup test",
        supports: () => ({ supported: false }),
        runAttempt: async () => {
          throw new Error("not used");
        },
        withSessionDeletion: async (params, run) => {
          deletionParams.push(params);
          return await run({ commit, rollback });
        },
      });
      await cleanupSystemAgentSession(session);
    });

    expect(deletionParams).toEqual([
      expect.objectContaining({
        agentId: "openclaw",
        bindingSessionKey: null,
        sessionId: session.sessionId,
        sessionKey: `agent:openclaw:${session.sessionId}`,
      }),
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });
});
