import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { executeSqliteQuerySync, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  decodeTranscriptNavigation,
  hasCertifiedTranscriptNavigation,
  readTranscriptNavigationSnapshot,
} from "./session-transcript-navigation.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { selectVisibleTranscriptEventEntries } from "./transcript-visible-events.js";

// Memory excerpts span compactions, but never reach across the latest reset.
// Reset history replays only user/assistant rows; discard kept-prefix tools
// before applying capture budgets, just like the projection reader.
function selectCurrentMemoryWindow(events: unknown[]) {
  const active = selectVisibleTranscriptEventEntries(events);
  const boundaryIndex = active.findLastIndex(
    ({ event }) => isRecord(event) && event.type === "reset",
  );
  const boundary = active[boundaryIndex]?.event;
  if (!isRecord(boundary)) {
    return active;
  }
  const firstKeptIndex =
    typeof boundary.firstKeptEntryId === "string"
      ? active.findIndex(({ event }) => isRecord(event) && event.id === boundary.firstKeptEntryId)
      : -1;
  const kept =
    firstKeptIndex >= 0 && firstKeptIndex < boundaryIndex
      ? active.slice(firstKeptIndex, boundaryIndex)
      : [];
  return [
    ...kept.filter(
      ({ event }) =>
        isRecord(event) &&
        event.type === "message" &&
        isRecord(event.message) &&
        (event.message.role === "user" || event.message.role === "assistant"),
    ),
    ...active.slice(boundaryIndex + 1),
  ];
}

/** Read a bounded memory excerpt from authoritative rows while the index is unavailable. */
export function readSessionTranscriptMemoryTail(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxMessages: number },
): TranscriptEvent[] {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : 0;
  const maxMessages = Number.isFinite(options.maxMessages)
    ? Math.max(0, Math.floor(options.maxMessages))
    : 0;
  if (!maxBytes || !maxMessages) {
    return [];
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          assertSessionTranscriptHot(database.db, resolved.sessionId);
          const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
          if (!readTranscriptNavigationSnapshot(database.db, resolved.sessionId)) {
            return [];
          }
          if (!hasCertifiedTranscriptNavigation(database.db, resolved.sessionId)) {
            startSessionTranscriptIndexReconcile({
              ...toDatabaseOptions(resolved),
              preferredSessionId: resolved.sessionId,
            });
            throw new Error("Transcript navigation unavailable until background repair completes");
          }
          const db = getSessionKysely(database.db);
          const sequences: number[] = [];
          const sizes: number[] = [];
          const events: unknown[] = [];
          const rows = iterateSqliteQuerySync(
            database.db,
            db
              .selectFrom("transcript_events")
              .select([
                "seq",
                "navigation_json",
                /* kysely-allow-raw: measure stored UTF-8 bytes before acquiring any message body. */
                sql<number>`OCTET_LENGTH(event_json) + 1`.as("bytes"),
              ])
              .where("session_id", "=", resolved.sessionId)
              // The admitted row can select an older branch. Retain its navigation
              // before choosing the path, but never include its payload below.
              .$if(fence !== undefined, (query) => query.where("seq", "<=", fence!.beforeRawSeq))
              .orderBy("seq", "asc"),
          );
          for (const row of rows) {
            const event = decodeTranscriptNavigation(row.navigation_json);
            events.push(event);
            sequences.push(row.seq);
            sizes.push(row.bytes);
          }
          const candidates = selectCurrentMemoryWindow(events)
            .filter(
              ({ event, seq }) =>
                isRecord(event) &&
                event.type === "message" &&
                (fence === undefined || sequences[seq - 1]! < fence.beforeRawSeq),
            )
            .slice(-maxMessages);
          const selected: number[] = [];
          let bytes = 0;
          // Selector sequences are one-based input positions, not SQLite sequence
          // numbers: sparse storage and legacy non-monotonic paths retain their order.
          for (const { seq } of candidates.toReversed()) {
            const index = seq - 1;
            const size = sizes[index]!;
            if (bytes + size <= maxBytes) {
              selected.push(sequences[index]!);
              bytes += size;
            }
          }
          if (!selected.length) {
            return [];
          }
          const payloads = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("transcript_events")
              .select(["seq", "event_json"])
              .where("session_id", "=", resolved.sessionId)
              .where("seq", "in", selected),
          ).rows;
          const bySeq = new Map(payloads.map((row) => [row.seq, row.event_json]));
          // Follow the selected path's order, including legacy non-monotonic ancestry.
          // Navigation and payloads share the same fenced read transaction.
          return selected.toReversed().map((seq) => JSON.parse(bySeq.get(seq)!));
        },
        { databaseLabel: database.path, operationLabel: "session memory transcript read" },
      ),
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  if (!opened.found) {
    throw new Error("Transcript navigation unavailable: database or schema missing");
  }
  return opened.value;
}
