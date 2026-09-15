import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { isUserAssistantReplayRole, isValidReplayTimestamp } from "./transcript-replay.js";
import { isCanonicalSessionTranscriptEntry } from "./transcript-tree.js";

const NAVIGATION_KEYS = [
  "type",
  "id",
  "parentId",
  "targetId",
  "appendParentId",
  "appendMode",
  "timestamp",
  "firstKeptEntryId",
] as const;

function navigationScalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  // Tree and replay owners reject boolean false where a string or null carries
  // meaning. Keep invalid fields present without retaining nested payloads or
  // letting JSON.stringify turn an overflowing number into a valid null parent.
  return false;
}

function navigationValue(event: Record<string, unknown>, key: (typeof NAVIGATION_KEYS)[number]) {
  const value = event[key];
  // Reset replay needs timestamp validity, not its original text. Identity
  // strings stay lossless; enum and eligibility facts must stay bounded.
  if (key === "timestamp" && typeof value === "string") {
    return isValidReplayTimestamp(value) ? 0 : false;
  }
  if (
    key === "type" &&
    typeof value === "string" &&
    value !== "session" &&
    value !== "leaf" &&
    !isCanonicalSessionTranscriptEntry(event)
  ) {
    return false;
  }
  if (key === "appendMode" && typeof value === "string" && value !== "side") {
    return false;
  }
  return navigationScalar(value);
}

/** JSON text, rather than decoded SQL TEXT identities, preserves every string code unit. */
export function encodeTranscriptNavigation(eventJson: string): string {
  try {
    const event: unknown = JSON.parse(eventJson);
    const navigation: Record<string, unknown> = {};
    if (isRecord(event)) {
      for (const key of NAVIGATION_KEYS) {
        if (Object.hasOwn(event, key)) {
          navigation[key] = navigationValue(event, key);
        }
      }
      if (Object.hasOwn(event, "message")) {
        navigation.message = isRecord(event.message)
          ? Object.hasOwn(event.message, "role")
            ? {
                role:
                  typeof event.message.role === "string" &&
                  !isUserAssistantReplayRole(event.message.role)
                    ? false
                    : navigationScalar(event.message.role),
              }
            : {}
          : // Non-object message values have no replay role. Do not duplicate an
            // opaque string/array body merely to retain its property presence.
            null;
      }
    }
    return JSON.stringify([1, isRecord(event) ? navigation : null]);
  } catch {
    // Terminal poison, not missing coverage: a malformed raw row must not cause
    // endless background retries. Raw history and its repair remain canonical.
    return "[1]";
  }
}

export function decodeTranscriptNavigation(json: string | null): unknown {
  const value: unknown = json === null ? undefined : JSON.parse(json);
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== 1 ||
    (value[1] !== null && !isRecord(value[1]))
  ) {
    throw new Error("Transcript navigation unavailable: malformed or unsupported metadata");
  }
  return value[1];
}

function hasMissingTranscriptNavigation(db: DatabaseSync, sessionId: string): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getSessionKysely(db)
        .selectFrom("transcript_events")
        .select("seq")
        .where("session_id", "=", sessionId)
        .where("navigation_json", "is", null)
        .limit(1),
    ) !== undefined
  );
}

export function hasCurrentTranscriptNavigationGeneration(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getSessionKysely(db)
        .selectFrom("transcript_rewrite_watermarks")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .whereRef("navigation_generation", "=", "generation"),
    ) !== undefined
  );
}

export function hasCertifiedTranscriptNavigation(db: DatabaseSync, sessionId: string): boolean {
  try {
    return (
      hasCurrentTranscriptNavigationGeneration(db, sessionId) &&
      !hasMissingTranscriptNavigation(db, sessionId)
    );
  } catch (error) {
    // Read-only opens accept the previous same-version shape; only writable
    // startup may add these columns. Other database failures still propagate.
    if (
      error instanceof Error &&
      /no such column: "?(?:[a-z_]+\.)?(?:navigation_generation|navigation_json)\b/u.test(
        error.message,
      )
    ) {
      return false;
    }
    throw error;
  }
}

/** Reads reset-planning facts inside the caller's existing hot read snapshot. */
export function readTranscriptNavigationInTransaction(
  db: DatabaseSync,
  sessionId: string,
  beforeEventSeq?: number,
): unknown[] {
  if (!readTranscriptNavigationSnapshot(db, sessionId)) {
    return [];
  }
  if (!hasCertifiedTranscriptNavigation(db, sessionId)) {
    throw new Error("Transcript navigation unavailable until background repair completes");
  }
  const rows = iterateSqliteQuerySync(
    db,
    getSessionKysely(db)
      .selectFrom("transcript_events")
      .select("navigation_json")
      .where("session_id", "=", sessionId)
      .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
      .orderBy("seq", "asc"),
  );
  return Array.from(rows, (row) => decodeTranscriptNavigation(row.navigation_json));
}

export function certifyTranscriptNavigationInTransaction(
  db: DatabaseSync,
  sessionId: string,
): void {
  if (hasMissingTranscriptNavigation(db, sessionId)) {
    return;
  }
  executeSqliteQuerySync(
    db,
    getSessionKysely(db)
      .updateTable("transcript_rewrite_watermarks")
      .set((eb) => ({ navigation_generation: eb.ref("generation") }))
      .where("session_id", "=", sessionId),
  );
}

export type TranscriptNavigationSnapshot = {
  sessionId: string;
  generation: string | null;
  maxSeq: number;
  updatedAt: number | null;
};

export function readTranscriptNavigationSnapshot(
  db: DatabaseSync,
  sessionId: string,
): TranscriptNavigationSnapshot | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSessionKysely(db)
      .selectFrom("session_windows as window")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .select((eb) => [
        "rewrite.generation",
        "window.transcript_updated_at",
        eb
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", sessionId)
          .orderBy("seq", "desc")
          .limit(1)
          .as("max_seq"),
      ])
      .where("window.session_id", "=", sessionId),
  );
  return row && row.max_seq !== null
    ? {
        sessionId,
        generation: row.generation,
        maxSeq: row.max_seq,
        updatedAt: row.transcript_updated_at,
      }
    : undefined;
}

export function transcriptNavigationSnapshotMatches(
  db: DatabaseSync,
  snapshot: TranscriptNavigationSnapshot,
): boolean {
  const current = readTranscriptNavigationSnapshot(db, snapshot.sessionId);
  return (
    current?.generation === snapshot.generation &&
    current?.maxSeq === snapshot.maxSeq &&
    current?.updatedAt === snapshot.updatedAt
  );
}

export type PreparedTranscriptNavigationRow = {
  seq: number;
  sourceBytes: Uint8Array;
  navigationJson: string;
};

/** Bounded repair commits compare canonical bytes, not JSON-normalized strings or row counts. */
export function applyTranscriptNavigationChunkInTransaction(
  db: DatabaseSync,
  snapshot: TranscriptNavigationSnapshot,
  rows: readonly PreparedTranscriptNavigationRow[],
): boolean {
  if (!transcriptNavigationSnapshotMatches(db, snapshot)) {
    return false;
  }
  const update = prepareSqliteQuerySync<PreparedTranscriptNavigationRow>(db, (parameter) =>
    getSessionKysely(db)
      .updateTable("transcript_events")
      .set({ navigation_json: parameter((row) => row.navigationJson) })
      .where("session_id", "=", snapshot.sessionId)
      .where(
        "seq",
        "=",
        parameter((row) => row.seq),
      )
      .where(
        /* kysely-allow-raw: exact BLOB comparison preserves NUL and malformed canonical bytes. */
        sql<Uint8Array>`CAST(event_json AS BLOB)`,
        "=",
        parameter((row) => row.sourceBytes),
      ),
  );
  for (const row of rows) {
    if (update(row).numAffectedRows !== 1n) {
      throw new Error("Transcript changed during navigation repair");
    }
  }
  return true;
}

/** Run in the existing reconcile worker; only one bounded raw chunk is retained. */
export async function repairTranscriptNavigation(
  db: DatabaseSync,
  sessionId: string,
  sink: {
    chunk: (
      snapshot: TranscriptNavigationSnapshot,
      rows: PreparedTranscriptNavigationRow[],
    ) => Promise<boolean>;
    finish: (snapshot: TranscriptNavigationSnapshot) => Promise<boolean>;
  },
): Promise<boolean> {
  if (hasCertifiedTranscriptNavigation(db, sessionId)) {
    return true;
  }
  const snapshot = readTranscriptNavigationSnapshot(db, sessionId);
  if (!snapshot) {
    return true;
  }
  const onlyMissing = hasCurrentTranscriptNavigationGeneration(db, sessionId);
  // BLOB casts expose the database encoding and never truncate at NUL.
  const encoding = /* sqlite-allow-raw: PRAGMA reads native encoding for exact BLOB decoding. */ db
    .prepare("PRAGMA encoding")
    .get()?.encoding;
  if (encoding !== "UTF-8" && encoding !== "UTF-16le" && encoding !== "UTF-16be") {
    throw new Error("Unsupported transcript database encoding");
  }
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  let afterSeq: number | undefined;
  for (;;) {
    const rows = runSqliteDeferredTransactionSync(
      db,
      () => {
        if (!transcriptNavigationSnapshotMatches(db, snapshot)) {
          return undefined;
        }
        const kysely = getSessionKysely(db);
        const candidates = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("transcript_events")
            .select([
              "seq",
              /* kysely-allow-raw: size canonical bytes before acquiring a bounded repair chunk. */ sql<number>`OCTET_LENGTH(event_json)`.as(
                "bytes",
              ),
            ])
            .where("session_id", "=", sessionId)
            .$if(afterSeq !== undefined, (query) => query.where("seq", ">", afterSeq!))
            .$if(onlyMissing, (query) => query.where("navigation_json", "is", null))
            .orderBy("seq")
            .limit(512),
        ).rows;
        let bytes = 0;
        const selected: number[] = [];
        for (const row of candidates) {
          if (selected.length && bytes + row.bytes > 256 * 1024) {
            break;
          }
          selected.push(row.seq);
          bytes += row.bytes;
        }
        if (!selected.length) {
          return [];
        }
        return executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("transcript_events")
            .select([
              "seq",
              // kysely-allow-raw: exact source bytes preserve NUL and database encoding.
              sql<Uint8Array>`CAST(event_json AS BLOB)`.as("sourceBytes"),
            ])
            .where("session_id", "=", sessionId)
            .where("seq", "in", selected)
            .orderBy("seq"),
        ).rows.map((row) => ({
          seq: row.seq,
          sourceBytes: row.sourceBytes,
          navigationJson: (() => {
            try {
              return encodeTranscriptNavigation(decoder.decode(row.sourceBytes));
            } catch {
              return "[1]";
            }
          })(),
        }));
      },
      { databaseLabel: "transcript navigation", operationLabel: "navigation repair source" },
    );
    if (!rows) {
      return false;
    }
    if (!rows.length) {
      break;
    }
    if (!(await sink.chunk(snapshot, rows))) {
      return false;
    }
    afterSeq = rows.at(-1)!.seq;
  }
  return await sink.finish(snapshot);
}
