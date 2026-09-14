import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { executeSqliteQuerySync, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
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
import { projectResetBoundaryNavigationSql } from "./session-model-context-projection.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { selectVisibleTranscriptEvents } from "./transcript-visible-events.js";

// Memory excerpts span compactions, but never reach across the latest reset.
// Reset history replays only user/assistant rows; discard kept-prefix tools
// before applying capture budgets, just like the projection reader.
function selectCurrentMemoryWindow(events: TranscriptEvent[]): TranscriptEvent[] {
  const active = selectVisibleTranscriptEvents(events);
  const boundaryIndex = active.findLastIndex((event) => isRecord(event) && event.type === "reset");
  const boundary = active[boundaryIndex];
  if (!isRecord(boundary)) {
    return active;
  }
  const firstKeptIndex =
    typeof boundary.firstKeptEntryId === "string"
      ? active.findIndex((event) => isRecord(event) && event.id === boundary.firstKeptEntryId)
      : -1;
  const kept =
    firstKeptIndex >= 0 && firstKeptIndex < boundaryIndex
      ? active.slice(firstKeptIndex, boundaryIndex)
      : [];
  return [
    ...kept.filter(
      (event) =>
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
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, resolved.sessionId);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      const db = getSessionKysely(database.db);
      const metadata = new Map<TranscriptEvent, { seq: number; bytes: number }>();
      const events: TranscriptEvent[] = [];
      const rows = iterateSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select((eb) => [
            "seq",
            projectResetBoundaryNavigationSql(eb.ref("event_json")).as("event_json"),
            /* kysely-allow-raw: measure stored UTF-8 bytes before acquiring any message body. */
            sql<number>`OCTET_LENGTH(event_json) + 1`.as("bytes"),
          ])
          .where("session_id", "=", resolved.sessionId)
          .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq))
          .orderBy("seq", "asc"),
      );
      for (const row of rows) {
        const event: TranscriptEvent = JSON.parse(row.event_json);
        events.push(event);
        metadata.set(event, { seq: row.seq, bytes: row.bytes });
      }
      const candidates = selectCurrentMemoryWindow(events)
        .filter((event) => isRecord(event) && event.type === "message")
        .slice(-maxMessages);
      const selected: number[] = [];
      let bytes = 0;
      for (const event of candidates.toReversed()) {
        const row = metadata.get(event)!;
        if (bytes + row.bytes <= maxBytes) {
          selected.push(row.seq);
          bytes += row.bytes;
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
  );
}
