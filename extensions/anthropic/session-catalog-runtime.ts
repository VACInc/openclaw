import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  listSessionCatalogEntries,
  type SessionCatalogEntrySnapshot,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS } from "./cli-constants.js";
import { adoptedSourceKey, CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";
import { localClaudeCatalogSourceId } from "./session-catalog-scan.js";

export function currentClaudeSessionCatalogConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

type ClaudeSessionEntry = {
  cliSessionBindings?: unknown;
  execHost?: string;
  execNode?: string;
  pluginOwnerId?: string;
  modelSelectionLocked?: boolean;
  pluginExtensions?: unknown;
};

function claudeBindingHostId(entry: ClaudeSessionEntry): string {
  const anthropic = isRecord(entry.pluginExtensions) ? entry.pluginExtensions.anthropic : undefined;
  const marker = isRecord(anthropic) ? anthropic.sessionCatalog : undefined;
  return isRecord(marker) && typeof marker.sourceHostId === "string"
    ? marker.sourceHostId
    : entry.execHost === "node" && typeof entry.execNode === "string" && entry.execNode.trim()
      ? `node:${entry.execNode.trim()}`
      : localClaudeCatalogSourceId();
}

function adoptedClaudeSource(
  pluginId: string,
  entry: ClaudeSessionEntry,
): { hostId: string; threadId: string } | undefined {
  const anthropic = isRecord(entry.pluginExtensions) ? entry.pluginExtensions.anthropic : undefined;
  const marker = isRecord(anthropic) ? anthropic.sessionCatalog : undefined;
  if (entry.pluginOwnerId !== pluginId || entry.modelSelectionLocked !== true) {
    return undefined;
  }
  return isRecord(marker) && typeof marker.sourceThreadId === "string"
    ? { hostId: claudeBindingHostId(entry), threadId: marker.sourceThreadId }
    : undefined;
}

function boundClaudeSource(pluginId: string, entry: ClaudeSessionEntry) {
  const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
  const binding = bindings?.[CLAUDE_CLI_BACKEND_ID];
  if (isRecord(binding) && typeof binding.sessionId === "string" && binding.sessionId) {
    return { hostId: claudeBindingHostId(entry), threadId: binding.sessionId };
  }
  return adoptedClaudeSource(pluginId, entry);
}

export function listBoundClaudeSessions(
  api: OpenClawPluginApi,
  agentId?: string,
  sessionEntries?: SessionCatalogEntrySnapshot,
): Map<string, string> {
  const config = currentClaudeSessionCatalogConfig(api);
  const bound = new Map<string, string>();
  for (const { sessionKey, entry } of listSessionCatalogEntries({
    agentId,
    config,
    runtime: api.runtime,
    sessionEntries,
  })) {
    const source = boundClaudeSource(api.id, entry);
    if (source) {
      bound.set(
        adoptedSourceKey(
          source.hostId === localClaudeCatalogSourceId()
            ? CLAUDE_LOCAL_SESSION_HOST_ID
            : source.hostId,
          source.threadId,
        ),
        sessionKey,
      );
    }
  }
  return bound;
}

export function listAdoptedClaudeSessions(
  api: OpenClawPluginApi,
  agentId?: string,
  sessionEntries?: SessionCatalogEntrySnapshot,
): Map<string, string> {
  const config = currentClaudeSessionCatalogConfig(api);
  const adopted = new Map<string, string>();
  for (const { sessionKey, entry } of listSessionCatalogEntries({
    agentId,
    config,
    runtime: api.runtime,
    sessionEntries,
  })) {
    const source = adoptedClaudeSource(api.id, entry);
    if (source) {
      adopted.set(adoptedSourceKey(source.hostId, source.threadId), sessionKey);
    }
  }
  return adopted;
}

/** Existing bindings that identify OpenClaw-created Claude sessions on upgrade. */
export function listManagedClaudeSessionCandidates(
  api: OpenClawPluginApi,
  sessionEntries?: SessionCatalogEntrySnapshot,
): Array<{ hostId: string; sessionId: string }> {
  const config = currentClaudeSessionCatalogConfig(api);
  const { ownership: _ownership, ...agentsWithoutOwnership } = config.agents ?? {};
  const managed = new Map<string, { hostId: string; sessionId: string }>();
  for (const { entry } of listSessionCatalogEntries({
    config: { ...config, agents: agentsWithoutOwnership },
    runtime: api.runtime,
    sessionEntries,
  })) {
    const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
    const binding = bindings?.[CLAUDE_CLI_BACKEND_ID];
    if (!isRecord(binding) || typeof binding.sessionId !== "string" || !binding.sessionId.trim()) {
      continue;
    }
    const sessionId = binding.sessionId.trim();
    if (adoptedClaudeSource(api.id, entry)?.threadId === sessionId) {
      continue;
    }
    const hostId = claudeBindingHostId(entry);
    managed.set(adoptedSourceKey(hostId, sessionId), { hostId, sessionId });
  }
  return [...managed.values()];
}

/**
 * Resolve the Claude model an agent actually routes to the Claude CLI backend.
 * Callers must not assume the current default is routed: existing configs pin
 * older Claude models, and stamping the default onto their sessions would
 * select a model the operator never routed or allowed.
 */
export function resolveClaudeCliRoutedModelId(
  config: OpenClawConfig,
  agentId: string,
): string | undefined {
  return CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS.find(
    (modelId) =>
      resolveEffectiveAgentRuntime({
        cfg: config,
        provider: "anthropic",
        modelId,
        agentId,
      }) === CLAUDE_CLI_BACKEND_ID,
  );
}
