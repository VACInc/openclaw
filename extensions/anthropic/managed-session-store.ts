import { createHash } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const CLAUDE_MANAGED_SESSION_NAMESPACE = "claude-cli-managed-sessions";
export const CLAUDE_MANAGED_SESSION_MAX_ENTRIES = 20_000;
const CLAUDE_MANAGED_SESSION_BACKFILL_KEY = "migration:managed-provenance-backfill:v3";

type ManagedSessionCandidate = { hostId: string; sessionId: string };
type ManagedSessionCandidateSource =
  | readonly ManagedSessionCandidate[]
  | (() => Promise<readonly ManagedSessionCandidate[]>);

type ClaudeManagedSession = {
  version: 1;
  kind: "managed-session";
  hostId: string;
  sessionId: string;
};

type ClaudeManagedSessionBackfill = {
  version: 3;
  kind: "managed-provenance-backfill-complete";
};

export type StoredClaudeManagedSession = ClaudeManagedSession | ClaudeManagedSessionBackfill;

export type ClaudeManagedSessionStore = {
  mark(params: ManagedSessionCandidate): Promise<boolean>;
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseManagedSession(value: unknown): ClaudeManagedSession | undefined {
  if (
    value === null ||
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== "managed-session"
  ) {
    return undefined;
  }
  const hostId = nonEmptyString(value.hostId);
  const sessionId = nonEmptyString(value.sessionId);
  return hostId && sessionId
    ? { version: 1, kind: "managed-session", hostId, sessionId }
    : undefined;
}

function isManagedSessionBackfill(value: unknown): value is ClaudeManagedSessionBackfill {
  return (
    value !== null &&
    isRecord(value) &&
    value.version === 3 &&
    value.kind === "managed-provenance-backfill-complete"
  );
}

/** Durable ownership index for Claude CLI sessions created by OpenClaw. */
export function createClaudeManagedSessionStore(
  state: Pick<
    PluginStateSyncKeyedStore<StoredClaudeManagedSession>,
    "entries" | "registerIfAbsent"
  >,
): ClaudeManagedSessionStore {
  const mark = async (params: ManagedSessionCandidate) => {
    try {
      const value = parseManagedSession({
        version: 1,
        kind: "managed-session",
        hostId: params.hostId.trim(),
        sessionId: params.sessionId.trim(),
      });
      if (!value) {
        throw new Error("invalid Claude managed session ownership");
      }
      state.registerIfAbsent(managedSessionKey(value.hostId, value.sessionId), value);
      return true;
    } catch (error) {
      // Catalog visibility must never prevent Claude session startup.
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
        const value = parseManagedSession(entry.value);
        if (!value) {
          continue;
        }
        const ids = byHost.get(value.hostId) ?? new Set<string>();
        ids.add(value.sessionId);
        byHost.set(value.hostId, ids);
      }
      const backfill = entries.find((entry) => entry.key === CLAUDE_MANAGED_SESSION_BACKFILL_KEY);
      if (!isManagedSessionBackfill(backfill?.value)) {
        const candidates =
          typeof legacyCandidateSource === "function"
            ? await legacyCandidateSource()
            : legacyCandidateSource;
        let complete = true;
        for (const candidate of candidates) {
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
