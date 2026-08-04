import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const effects = vi.hoisted(() => ({
  mutateConfigFileWithRetry: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry };
});

// These tests own model mutation scope; session-utils.test.ts owns the thinking
// projection that otherwise materializes provider policy for every mutation here.
vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionThinkingProjection: vi.fn(() => ({
      agentRuntime: { id: "openclaw", source: "implicit" },
      effectiveThinkingLevel: "off",
      thinkingLevels: [],
    })),
  };
});

import { sessionMutationHandlers } from "./sessions-mutations.js";

const cfg = {
  agents: {
    defaults: { model: "anthropic/claude-opus-4-6" },
    list: [
      { id: "main", default: true },
      { id: "work", model: "anthropic/claude-sonnet-4-6" },
    ],
  },
} satisfies OpenClawConfig;

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalog: vi.fn(async () => [
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "openai", id: "gpt-5.6-sol" },
    ]),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

function client(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.admin"],
    },
  };
}

async function patchSession(params: Record<string, unknown>) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: client(),
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

beforeEach(() => {
  effects.mutateConfigFileWithRetry.mockReset();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("sessions.patch model scope", () => {
  it.each([
    { agentId: "main", sessionKey: "agent:main:dm:model-scope" },
    { agentId: "work", sessionKey: "agent:work:dm:model-scope" },
  ])(
    "keeps an accepted $agentId model selection in its session",
    async ({ agentId, sessionKey }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const configuredBefore = structuredClone(cfg);
        await upsertSessionEntry(
          { agentId, sessionKey },
          { sessionId: `session-${agentId}`, updatedAt: 1 },
        );

        const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" });

        expect(response[0]).toBe(true);
        expect(loadSessionEntry({ agentId, sessionKey })).toMatchObject({
          providerOverride: "openai",
          modelOverride: "gpt-5.6-sol",
          modelOverrideSource: "user",
        });
        expect(cfg).toEqual(configuredBefore);
        expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
      });
    },
  );

  it("resets a session override without rewriting the configured default", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dm:model-default";
      const configuredBefore = structuredClone(cfg);
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-5.6-sol",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      );

      const response = await patchSession({
        key: sessionKey,
        model: "anthropic/claude-opus-4-6",
      });

      expect(response[0]).toBe(true);
      const entry = loadSessionEntry({ agentId: "main", sessionKey });
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(cfg).toEqual(configuredBefore);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    });
  });
});
