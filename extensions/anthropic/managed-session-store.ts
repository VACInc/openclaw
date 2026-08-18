import { createHash } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";

export const CLAUDE_MANAGED_SESSION_NAMESPACE = "claude-cli-managed-sessions";
export const CLAUDE_MANAGED_SESSION_MAX_ENTRIES = 20_000;
const CLAUDE_MANAGED_SESSION_BACKFILL_KEY = "migration:managed-provenance-backfill:v3";

type ManagedSessionCandidate = { hostId: string; sessionId: string };
type ManagedSessionCandidateSource =
  | readonly ManagedSessionCandidate[]
  | (() => Promise<readonly ManagedSessionCandidate[]>);

const managedSessionSchema = z.object({
  version: z.literal(1),
  kind: z.literal("managed-session"),
  hostId: z.string().min(1),
  sessionId: z.string().min(1),
});

const migrationSchema = z.object({
  version: z.literal(3),
  kind: z.literal("managed-provenance-backfill-complete"),
});

export type StoredClaudeManagedSession =
  | z.infer<typeof managedSessionSchema>
  | z.infer<typeof migrationSchema>;

export type ClaudeManagedSessionStore = {
  mark(params: { hostId: string; sessionId: string }): Promise<boolean>;
  snapshot(
    legacyCandidates?: ManagedSessionCandidateSource,
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
};

function managedSessionKey(hostId: string, sessionId: string): string {
  return `sha256:${createHash("sha256")
    .update("openclaw:claude-managed-session:v1\0")
    .update(hostId)
    .update("\0")
    .update(sessionId)
    .digest("hex")}`;
}

/** Durable ownership index for Claude CLI sessions created by OpenClaw. */
export function createClaudeManagedSessionStore(
  state: Pick<
    PluginStateSyncKeyedStore<StoredClaudeManagedSession>,
    "entries" | "registerIfAbsent"
  >,
): ClaudeManagedSessionStore {
  const mark = async (params: { hostId: string; sessionId: string }) => {
    try {
      const value = managedSessionSchema.parse({
        version: 1,
        kind: "managed-session",
        hostId: params.hostId.trim(),
        sessionId: params.sessionId.trim(),
      });
      state.registerIfAbsent(managedSessionKey(value.hostId, value.sessionId), value);
      return true;
    } catch (error) {
      // This index changes catalog visibility only. Session execution must survive
      // a full or temporarily unavailable plugin-state store.
      embeddedAgentLog.warn("failed to record Claude managed session ownership", { error });
      return false;
    }
  };
  return {
    mark,
    async snapshot(legacyCandidateSource = []) {
      const byHost = new Map<string, Set<string>>();
      const entries = state.entries();
      for (const entry of entries) {
        const parsed = managedSessionSchema.safeParse(entry.value);
        if (!parsed.success) {
          continue;
        }
        const ids = byHost.get(parsed.data.hostId) ?? new Set<string>();
        ids.add(parsed.data.sessionId);
        byHost.set(parsed.data.hostId, ids);
      }
      if (!entries.some((entry) => entry.key === CLAUDE_MANAGED_SESSION_BACKFILL_KEY)) {
        const legacyCandidates =
          typeof legacyCandidateSource === "function"
            ? await legacyCandidateSource()
            : legacyCandidateSource;
        let complete = true;
        for (const candidate of legacyCandidates) {
          complete = (await mark(candidate)) && complete;
          const ids = byHost.get(candidate.hostId) ?? new Set<string>();
          ids.add(candidate.sessionId);
          byHost.set(candidate.hostId, ids);
        }
        if (complete) {
          try {
            state.registerIfAbsent(CLAUDE_MANAGED_SESSION_BACKFILL_KEY, {
              version: 3,
              kind: "managed-provenance-backfill-complete",
            });
          } catch (error) {
            embeddedAgentLog.warn("failed to complete Claude managed session backfill", { error });
          }
        }
      }
      return byHost;
    },
  };
}
