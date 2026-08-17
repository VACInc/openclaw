import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";

export const CODEX_MANAGED_THREAD_NAMESPACE = "app-server-managed-threads";
export const CODEX_MANAGED_THREAD_MAX_ENTRIES = 50_001;

const managedThreadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("managed-thread"),
  sourceHomeId: z.string().min(1),
  threadId: z.string().min(1),
  rolloutPath: z.string().min(1).optional(),
});

const migrationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("binding-backfill-complete"),
});

export type StoredCodexManagedThread =
  | z.infer<typeof managedThreadSchema>
  | z.infer<typeof migrationSchema>;

export type CodexManagedThreadStore = {
  mark(params: { sourceHomeId: string; threadId: string; rolloutPath?: string }): Promise<void>;
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
    throw new Error("Codex managed thread ownership requires a resolvable Codex home");
  }
  await store.mark({
    sourceHomeId: codexManagedThreadSourceHomeId(codexHome),
    threadId: params.threadId,
    ...(params.rolloutPath ? { rolloutPath: params.rolloutPath } : {}),
  });
}

export const CODEX_MANAGED_THREAD_BACKFILL_KEY = "migration:binding-backfill:v1";

function canonicalCodexHome(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Stable opaque identity shared by runtime ownership rows and catalog homes. */
export function codexManagedThreadSourceHomeId(codexHome: string): string {
  return createHash("sha256")
    .update("openclaw:codex-session-catalog-home:v1\0")
    .update(canonicalCodexHome(codexHome))
    .digest("hex");
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
  return canonicalCodexHome(home);
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
      const value = managedThreadSchema.parse({
        version: 1,
        kind: "managed-thread",
        sourceHomeId: params.sourceHomeId.trim(),
        threadId: params.threadId.trim(),
        ...(params.rolloutPath?.trim() ? { rolloutPath: params.rolloutPath.trim() } : {}),
      });
      state.registerIfAbsent(managedThreadStoreKey(value.sourceHomeId, value.threadId), value);
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
