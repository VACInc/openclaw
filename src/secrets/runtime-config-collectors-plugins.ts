import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { listPluginConfigSecretPaths } from "../plugins/config-secrets.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { setPathExistingStrict } from "./path-utils.js";
import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";
import { expandPathTokens, parsePathPattern } from "./target-registry-pattern.js";

function formatPluginInactiveReason(reason?: string): string {
  if (!reason) {
    return "plugin is inactive.";
  }
  return `plugin is inactive (${reason}).`;
}

export function collectPluginConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const plugins = params.config.plugins;
  if (!isRecord(plugins?.entries)) {
    return;
  }

  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
  );
  const manifestRegistry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir,
    env: params.context.env,
  });
  const normalizedPlugins = normalizePluginsConfig(params.config.plugins);
  const seenPluginIds = new Set<string>();
  let selectedMemoryPluginId: string | null = null;

  for (const record of manifestRegistry.plugins) {
    if (seenPluginIds.has(record.id)) {
      continue;
    }
    seenPluginIds.add(record.id);

    const entry = normalizedPlugins.entries[record.id];
    const entryConfig = entry?.config;
    if (!record.configSchema || !isRecord(entryConfig)) {
      continue;
    }

    const enableState = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.config,
      enabledByDefault: record.enabledByDefault,
    });
    let active = enableState.enabled;
    let inactiveReason = enableState.reason;

    if (active) {
      const memoryDecision = resolveMemorySlotDecision({
        id: record.id,
        kind: record.kind,
        slot: normalizedPlugins.slots.memory,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        active = false;
        inactiveReason = memoryDecision.reason;
      } else if (memoryDecision.selected) {
        selectedMemoryPluginId = record.id;
      }
    }

    const secretPaths = listPluginConfigSecretPaths({
      schema: record.configSchema,
      uiHints: record.configUiHints,
    });
    for (const relPath of secretPaths) {
      const matches = expandPathTokens(entryConfig, parsePathPattern(relPath));
      for (const match of matches) {
        const fullPath = `plugins.entries.${record.id}.config.${match.segments.join(".")}`;
        collectSecretInputAssignment({
          value: match.value,
          path: fullPath,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          active,
          inactiveReason: formatPluginInactiveReason(inactiveReason),
          apply: (value) => {
            setPathExistingStrict(entryConfig as OpenClawConfig, match.segments, value);
          },
        });
      }
    }
  }
}
