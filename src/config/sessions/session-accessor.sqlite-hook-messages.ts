// Raw command-hook snapshots are not reset-relative display history.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type Expression, type RawBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readHotSessionTranscriptSnapshot,
  readRestoredSessionTranscript,
} from "./session-cold-storage-read.js";
import {
  projectTranscriptNavigation,
  projectTranscriptNavigationSql,
} from "./session-model-context-projection.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  hasAcceptedSessionTranscriptLeafControl,
  selectSessionTranscriptLeafControlledPath,
} from "./transcript-tree.js";

function rawTypeSql(event: Expression<string>): RawBuilder<string | null> {
  // json_extract selects the first duplicate. JSON.parse, the raw owner, keeps the last.
  /* kysely-allow-raw: ordered root members preserve JSON.parse duplicate-member semantics. */
  return sql<string | null>`CASE WHEN json_valid(${event}) THEN
    (SELECT atom FROM json_each(${event}) WHERE key = 'type' ORDER BY id DESC LIMIT 1)
    ELSE NULL END`;
}

function messageEligibilitySql(event: Expression<string>): RawBuilder<number | null> {
  /* kysely-allow-raw: CASE protects SQLite-overdepth JSON; last root members match the raw parser without returning bodies. */
  return sql<number | null>`CASE WHEN json_valid(${event}) THEN
    CASE WHEN ${rawTypeSql(event)} = 'message' THEN COALESCE(
      (SELECT CASE type WHEN 'object' THEN 1 WHEN 'array' THEN 1 WHEN 'true' THEN 1
        WHEN 'text' THEN atom <> '' WHEN 'integer' THEN atom <> 0 WHEN 'real' THEN atom <> 0
        ELSE 0 END FROM json_each(${event}) WHERE key = 'message' ORDER BY id DESC LIMIT 1), 0)
      ELSE 0 END ELSE NULL END`;
}

/** Count/classify in SQLite where compatible; decode exceptional rows only inside a fixed budget. */
export async function readSessionTranscriptHookMessages(
  scope: SessionTranscriptReadScope,
  limits: { maxMessages: number; maxBytes: number },
): Promise<{ messages: unknown[]; totalMessages?: number; truncated: boolean }> {
  return readRestoredSessionTranscript(scope, () => {
    const resolved = resolveSqliteTranscriptReadScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    return readHotSessionTranscriptSnapshot(database, resolved.sessionId, "events", () => {
      const db = getSessionKysely(database.db);
      const maxMessages = Math.max(0, Math.floor(limits.maxMessages));
      const maxBytes = Math.max(0, Math.floor(limits.maxBytes));
      const incomplete = () => ({ messages: [], truncated: true });
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      const rows = db
        .selectFrom("transcript_events")
        .where("session_id", "=", resolved.sessionId)
        .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq));
      const readBoundedRow = (seq: number, bytes: number): unknown => {
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          rows
            .select("event_json")
            .where("seq", "=", seq)
            .where((eb) => eb(eb.fn<number>("octet_length", ["event_json"]), "<=", bytes)),
        );
        if (!row) {
          throw new Error("Raw hook row exceeded its pre-hydration budget");
        }
        return JSON.parse(row.event_json);
      };
      const compatible = new Map<
        number,
        { navigation: Record<string, unknown>; message?: unknown }
      >();
      let compatibilityBytes = 2;
      for (const row of iterateSqliteQuerySync(
        database.db,
        rows
          .select((eb) => ["seq", eb.fn<number>("octet_length", ["event_json"]).as("bytes")])
          .where((eb) => eb(eb.fn<number>("json_valid", ["event_json"]), "=", 0))
          .orderBy("seq", "desc"),
      )) {
        // Classification must not smuggle an oversized body past the payload cap.
        // If its bounded fallback cannot establish membership/topology, say unknown.
        if (compatible.size >= maxMessages || compatibilityBytes + row.bytes + 1 > maxBytes) {
          return incomplete();
        }
        const event = readBoundedRow(row.seq, maxBytes - compatibilityBytes - 1);
        compatibilityBytes += row.bytes + 1;
        const record = asOptionalRecord(event);
        compatible.set(row.seq, {
          navigation: projectTranscriptNavigation(event, { includeResetBoundary: true }),
          ...(record?.type === "message" && record.message ? { message: record.message } : {}),
        });
      }
      const compatibleLeaves = [...compatible]
        .filter(([, row]) => row.navigation.type === "leaf")
        .map(([seq]) => String(seq));
      const compatibleMessages = [...compatible]
        .filter(([, row]) => row.message !== undefined)
        .map(([seq]) => String(seq));
      const lastLeaf = executeSqliteQueryTakeFirstSync(
        database.db,
        rows
          .select("seq")
          .where((eb) =>
            eb.or([
              eb(rawTypeSql(eb.ref("event_json")), "=", "leaf"),
              eb(eb.cast<string>("seq", "text"), "in", sqliteStringSet(compatibleLeaves)),
            ]),
          )
          .orderBy("seq", "desc")
          .limit(1),
      );
      let metadataComplete = true;
      function* navigationRows(lastSeq?: number) {
        const projected = projectTranscriptNavigationSql(sql.ref<string>("event_json"), {
          includeResetBoundary: true,
        });
        /* kysely-allow-raw: size only metadata before transferring it; incompatible rows already belong to the bounded fallback. */
        const size = sql<number>`CASE WHEN json_valid(event_json)
          THEN octet_length(${projected}) ELSE octet_length(event_json) END`;
        const readNavigation = prepareSqliteQuerySync<number, { navigation: string }>(
          database.db,
          (parameter) =>
            rows.select(projected.as("navigation")).where(
              "seq",
              "=",
              parameter((seq) => seq),
            ),
        );
        let count = 0;
        let bytes = 2;
        for (const row of iterateSqliteQuerySync(
          database.db,
          rows
            .select(["seq", size.as("bytes")])
            .$if(lastSeq !== undefined, (query) => query.where("seq", "<=", lastSeq!))
            .orderBy("seq", "asc")
            .limit(maxMessages + 1),
        )) {
          // Bound both the leaf detector and the canonical fallback graph, not just each row.
          if (count >= maxMessages || bytes + row.bytes + 1 > maxBytes) {
            metadataComplete = false;
            return;
          }
          count += 1;
          bytes += row.bytes + 1;
          const fallback = compatible.get(row.seq);
          const navigation =
            fallback?.navigation ??
            projectTranscriptNavigation(JSON.parse(readNavigation(row.seq).rows[0]!.navigation), {
              includeResetBoundary: true,
            });
          yield { ...navigation, seq: row.seq };
        }
      }
      const hasLeafControl =
        lastLeaf !== undefined &&
        hasAcceptedSessionTranscriptLeafControl(navigationRows(lastLeaf.seq));
      if (!metadataComplete) {
        return incomplete();
      }
      let authoritativeSeqs: number[] | undefined;
      if (hasLeafControl) {
        // The display index cannot establish raw reset-prefix membership or a
        // fenced historical branch. Use the same bounded canonical owner in every state.
        const navigation = [...navigationRows()];
        if (!metadataComplete) {
          return incomplete();
        }
        authoritativeSeqs = (
          selectSessionTranscriptLeafControlledPath(navigation) ?? navigation
        ).map((entry) => entry.seq);
      }
      const source = db
        .selectFrom("transcript_events as event")
        .where("event.session_id", "=", resolved.sessionId)
        .where((eb) =>
          eb.or([
            eb(messageEligibilitySql(eb.ref("event.event_json")), "=", 1),
            eb(eb.cast<string>("event.seq", "text"), "in", sqliteStringSet(compatibleMessages)),
          ]),
        )
        .$if(fence !== undefined, (query) => query.where("event.seq", "<", fence!.beforeRawSeq))
        .$if(authoritativeSeqs !== undefined, (query) =>
          query.where((eb) =>
            eb(
              eb.cast<string>("event.seq", "text"),
              "in",
              sqliteStringSet(authoritativeSeqs!.map(String)),
            ),
          ),
        );
      const totalMessages =
        executeSqliteQueryTakeFirstSync(
          database.db,
          source.select((eb) => eb.fn.countAll<number>().as("count")),
        )?.count ?? 0;
      const metadataQuery = source.select((eb) => [
        "event.seq",
        eb.fn<number>("octet_length", ["event.event_json"]).as("bytes"),
      ]);
      let metadata: Array<{ seq: number; bytes: number }>;
      if (authoritativeSeqs !== undefined) {
        // The navigation graph is bounded above. Preserve its order, including
        // duplicate IDs whose current ancestors were stored after their descendants.
        const bySeq = new Map(
          executeSqliteQuerySync(database.db, metadataQuery).rows.map((row) => [row.seq, row]),
        );
        metadata = authoritativeSeqs
          .toReversed()
          .flatMap((seq) => {
            const row = bySeq.get(seq);
            return row ? [row] : [];
          })
          .slice(0, maxMessages);
      } else {
        metadata = executeSqliteQuerySync(
          database.db,
          metadataQuery.orderBy("event.seq", "desc").limit(maxMessages),
        ).rows;
      }
      const selected: number[] = [];
      let bytes = 2;
      for (const row of metadata) {
        if (bytes + row.bytes + 1 > maxBytes) {
          break;
        }
        selected.push(row.seq);
        bytes += row.bytes + 1;
      }
      const selectedSet = new Set(selected);
      // Discard unselected fallback bodies before hydrating ordinary selected rows.
      for (const seq of compatible.keys()) {
        if (!selectedSet.has(seq)) {
          compatible.delete(seq);
        }
      }
      const ordinary = selected.filter((seq) => !compatible.has(seq));
      const messagesBySeq = new Map<number, unknown>();
      if (ordinary.length > 0) {
        for (const row of executeSqliteQuerySync(
          database.db,
          rows.select(["seq", "event_json"]).where("seq", "in", ordinary),
        ).rows) {
          const event = asOptionalRecord(JSON.parse(row.event_json));
          messagesBySeq.set(row.seq, event?.message);
        }
      }
      const messages = selected
        .toReversed()
        .map((seq) => compatible.get(seq)?.message ?? messagesBySeq.get(seq));
      return { messages, totalMessages, truncated: totalMessages > messages.length };
    });
  });
}
