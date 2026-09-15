// Raw command-hook snapshots are not reset-relative display history.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
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
import { projectTranscriptNavigationSql } from "./session-model-context-projection.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  hasAcceptedSessionTranscriptLeafControl,
  selectSessionTranscriptLeafControlledPath,
} from "./transcript-tree.js";

/**
 * Preserve the command hook's raw message membership: flat storage until leaf
 * navigation is present, then the canonical active path, spanning old resets.
 * Count/type scans stay in SQLite; only a count- and byte-bounded tail crosses
 * into JavaScript. Never fetch an oversized event to size it.
 */
export async function readSessionTranscriptHookMessages(
  scope: SessionTranscriptReadScope,
  limits: { maxMessages: number; maxBytes: number },
): Promise<{ messages: unknown[]; totalMessages: number }> {
  return readRestoredSessionTranscript(scope, () => {
    const resolved = resolveSqliteTranscriptReadScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    return readHotSessionTranscriptSnapshot(database, resolved.sessionId, "events", () => {
      const db = getSessionKysely(database.db);
      const identity = db
        .selectFrom("transcript_event_identities")
        .select(["session_id", "seq", "event_type"])
        .modifyEnd(
          // The covering type index otherwise scans the session per joined row.
          /* kysely-allow-raw: pin the existing sequence index to avoid quadratic raw-history joins. */
          sql`INDEXED BY idx_agent_transcript_event_identity_sequence`,
        )
        .as("identity");
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      // Avoid a navigation scan for the common leaf-free transcript. The
      // identity index can omit earlier duplicate IDs, so inspect unindexed
      // types too, just as the raw message query does below.
      const lastLeaf = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_events as event")
          .leftJoin(identity, (join) =>
            join
              .onRef("identity.session_id", "=", "event.session_id")
              .onRef("identity.seq", "=", "event.seq"),
          )
          .select("event.seq")
          .where("event.session_id", "=", resolved.sessionId)
          .where((eb) =>
            eb(
              eb.fn.coalesce(
                "identity.event_type",
                eb.fn<string>("json_extract", ["event.event_json", eb.val("$.type")]),
              ),
              "=",
              "leaf",
            ),
          )
          .$if(fence !== undefined, (query) => query.where("event.seq", "<", fence!.beforeRawSeq))
          .orderBy("event.seq", "desc")
          .limit(1),
      );
      const hasLeafControl =
        lastLeaf !== undefined &&
        hasAcceptedSessionTranscriptLeafControl(
          (function* () {
            // Only navigation fields cross this boundary, never message bodies.
            // The canonical owner stops at its first accepted control; dangling,
            // forward and invalid-control references must not switch membership.
            const rows = iterateSqliteQuerySync(
              database.db,
              db
                .selectFrom("transcript_events")
                .select((eb) =>
                  projectTranscriptNavigationSql(eb.ref("event_json")).as("navigation"),
                )
                .where("session_id", "=", resolved.sessionId)
                .where("seq", "<=", lastLeaf.seq)
                .orderBy("seq", "asc"),
            );
            for (const row of rows) {
              yield JSON.parse(row.navigation);
            }
          })(),
        );
      let authoritativeSeqs: number[] | undefined;
      if (hasLeafControl) {
        try {
          // Reuse the active-path index only when it belongs to this snapshot.
          withCurrentProjectionSnapshot(scope, () => undefined);
        } catch (error) {
          if (!isSessionTranscriptProjectionUnavailableError(error)) {
            throw error;
          }
          // Reset preparation can hold writer admission. Waiting for the index
          // worker here would deadlock its publication. Resolve raw navigation
          // in the same read snapshot instead; never fetch its message bodies.
          const navigation: Array<Record<string, unknown> & { seq: number }> = [];
          for (const row of iterateSqliteQuerySync(
            database.db,
            db
              .selectFrom("transcript_events")
              .select((eb) => [
                "seq",
                projectTranscriptNavigationSql(eb.ref("event_json")).as("navigation"),
              ])
              .where("session_id", "=", resolved.sessionId)
              .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq))
              .orderBy("seq", "asc"),
          )) {
            navigation.push(
              Object.assign({}, asOptionalRecord(JSON.parse(row.navigation)), { seq: row.seq }),
            );
          }
          const selected = selectSessionTranscriptLeafControlledPath(navigation) ?? navigation;
          authoritativeSeqs = selected.map((entry) => entry.seq);
        }
      }
      const source = db
        .selectFrom("transcript_events as event")
        .leftJoin(identity, (join) =>
          join
            .onRef("identity.session_id", "=", "event.session_id")
            .onRef("identity.seq", "=", "event.seq"),
        )
        .where("event.session_id", "=", resolved.sessionId)
        .where((eb) =>
          eb(
            eb.fn.coalesce(
              "identity.event_type",
              eb.fn<string>("json_extract", ["event.event_json", eb.val("$.type")]),
            ),
            "=",
            "message",
          ),
        )
        // Match the old raw parser before counting or taking the tail. SQLite
        // evaluates eligibility without transferring message bodies to JS. This
        // count is O(retained source bytes), not a constant-time reset claim.
        .where((eb) => {
          const type = eb.fn<string>("json_type", ["event.event_json", eb.val("$.message")]);
          const value = eb.fn<string | number>("json_extract", [
            "event.event_json",
            eb.val("$.message"),
          ]);
          return eb.or([
            eb(type, "in", ["object", "array", "true"]),
            eb.and([eb(type, "=", "text"), eb(value, "!=", "")]),
            eb.and([eb(type, "in", ["integer", "real"]), eb(value, "!=", 0)]),
          ]);
        })
        .$if(fence !== undefined, (query) => query.where("event.seq", "<", fence!.beforeRawSeq))
        .$if(hasLeafControl && authoritativeSeqs === undefined, (query) =>
          query.where((eb) =>
            eb.exists(
              eb
                .selectFrom("session_transcript_active_events as active")
                .select("active.event_seq")
                .whereRef("active.session_id", "=", "event.session_id")
                .whereRef("active.event_seq", "=", "event.seq"),
            ),
          ),
        )
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
      const maxMessages = Math.max(0, Math.floor(limits.maxMessages));
      const maxBytes = Math.max(0, Math.floor(limits.maxBytes));
      const metadata = executeSqliteQuerySync(
        database.db,
        source
          .select((eb) => [
            "event.seq",
            eb.fn<number>("octet_length", ["event.event_json"]).as("bytes"),
          ])
          .orderBy("event.seq", "desc")
          .limit(maxMessages),
      ).rows;
      const selected: number[] = [];
      // Include array punctuation as well as the stored event envelope. The raw
      // message is smaller than that envelope, so this is a conservative budget.
      let bytes = 2;
      for (const row of metadata) {
        if (bytes + row.bytes + 1 > maxBytes) {
          break;
        }
        selected.push(row.seq);
        bytes += row.bytes + 1;
      }
      const messages =
        selected.length === 0
          ? []
          : executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("transcript_events")
                .select("event_json")
                .where("session_id", "=", resolved.sessionId)
                .where("seq", "in", selected)
                .orderBy("seq", "asc"),
            ).rows.flatMap((row) => {
              const event = asOptionalRecord(JSON.parse(row.event_json));
              return event?.message ? [event.message] : [];
            });
      return { messages, totalMessages };
    });
  });
}
