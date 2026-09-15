// Raw command-hook snapshots are not reset-relative display history.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
} from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { projectTranscriptNavigationSql } from "./session-model-context-projection.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { hasAcceptedSessionTranscriptLeafControl } from "./transcript-tree.js";

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
  return readRestoredSessionTranscript(scope, () =>
    withCurrentProjectionSnapshot(scope, (projection) => {
      const { database, resolved } = projection;
      const db = getActiveTranscriptKysely(database);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      // Avoid a navigation scan for the common leaf-free transcript. The
      // identity index can omit earlier duplicate IDs, so inspect unindexed
      // types too, just as the raw message query does below.
      const lastLeaf = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_events as event")
          .leftJoin("transcript_event_identities as identity", (join) =>
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
      const source = db
        .selectFrom("transcript_events as event")
        .leftJoin("transcript_event_identities as identity", (join) =>
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
        .$if(hasLeafControl, (query) =>
          query.where((eb) =>
            eb.exists(
              eb
                .selectFrom("session_transcript_active_events as active")
                .select("active.event_seq")
                .whereRef("active.session_id", "=", "event.session_id")
                .whereRef("active.event_seq", "=", "event.seq"),
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
    }),
  );
}
