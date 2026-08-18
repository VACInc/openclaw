import { createHash } from "node:crypto";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";
import { canonicalCodexCatalogHome, codexCatalogHomeId } from "../session-catalog-home-id.js";

export const CODEX_MANAGED_THREAD_NAMESPACE = "app-server-managed-threads";
export const CODEX_MANAGED_THREAD_MAX_ENTRIES = 20_000;

const managedThreadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("managed-thread"),
  sourceHomeId: z.string().min(1),
  threadId: z.string().min(1),
  rolloutPath: z.string().min(1).optional(),
});

export type StoredCodexManagedThread = z.infer<typeof managedThreadSchema>;

export type CodexManagedThreadStore = {
  mark(params: { sourceHomeId: string; threadId: string; rolloutPath?: string }): Promise<boolean>;
  snapshot(): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
};

export async function markStartedCodexManagedThread(
  store: CodexManagedThreadStore | undefined,
  params: { codexHome?: () => string | undefined; rolloutPath?: string; threadId: string },
): Promise<void> {
  if (!store) {
    return;
  }
  const codexHome =
    (params.rolloutPath ? codexHomeFromRolloutPath(params.rolloutPath) : undefined) ??
    params.codexHome?.();
  if (!codexHome) {
    embeddedAgentLog.warn("codex managed thread ownership has no resolvable Codex home", {
      threadId: params.threadId,
    });
    return;
  }
  try {
    await store.mark({
      sourceHomeId: codexCatalogHomeId(codexHome),
      threadId: params.threadId,
      ...(params.rolloutPath ? { rolloutPath: params.rolloutPath } : {}),
    });
  } catch (error) {
    // Keep this boundary fail-open even for a custom or legacy store implementation.
    // A catalog duplicate is less harmful than rejecting an otherwise valid new session.
    embeddedAgentLog.warn("failed to record Codex managed thread ownership", { error });
  }
}

/** Recovers CODEX_HOME from a canonical rollout path under CODEX_HOME/sessions. */
export function codexHomeFromRolloutPath(rolloutPath: string): string | undefined {
  const resolved = path.resolve(rolloutPath);
  const segments = resolved.split(path.sep);
  const sessionsIndex = segments.lastIndexOf("sessions");
  if (sessionsIndex <= 0 || sessionsIndex === segments.length - 1) {
    return undefined;
  }
  const home = segments.slice(0, sessionsIndex).join(path.sep) || path.parse(resolved).root;
  return canonicalCodexCatalogHome(home);
}

function managedThreadStoreKey(sourceHomeId: string, threadId: string): string {
  return `sha256:${createHash("sha256")
    .update("openclaw:codex-managed-thread:v1\0")
    .update(sourceHomeId)
    .update("\0")
    .update(threadId)
    .digest("hex")}`;
}

/** Durable ownership index for Codex threads created by OpenClaw. */
export function createCodexManagedThreadStore(
  state: Pick<PluginStateSyncKeyedStore<StoredCodexManagedThread>, "entries" | "registerIfAbsent">,
): CodexManagedThreadStore {
  return {
    async mark(params) {
      try {
        const value = managedThreadSchema.parse({
          version: 1,
          kind: "managed-thread",
          sourceHomeId: params.sourceHomeId.trim(),
          threadId: params.threadId.trim(),
          ...(params.rolloutPath?.trim() ? { rolloutPath: params.rolloutPath.trim() } : {}),
        });
        state.registerIfAbsent(managedThreadStoreKey(value.sourceHomeId, value.threadId), value);
        return true;
      } catch (error) {
        // Catalog ownership is advisory bookkeeping. Losing an old catalog exclusion is safer
        // than aborting a real Codex session start when plugin state is full or unavailable.
        embeddedAgentLog.warn("failed to record Codex managed thread ownership", { error });
        return false;
      }
    },
    async snapshot() {
      const byHome = new Map<string, Set<string>>();
      for (const entry of state.entries()) {
        const parsed = managedThreadSchema.safeParse(entry.value);
        if (!parsed.success) {
          continue;
        }
        const ids = byHome.get(parsed.data.sourceHomeId) ?? new Set<string>();
        ids.add(parsed.data.threadId);
        byHome.set(parsed.data.sourceHomeId, ids);
      }
      return byHome;
    },
  };
}
