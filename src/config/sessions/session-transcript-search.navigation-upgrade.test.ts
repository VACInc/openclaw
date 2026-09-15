import { expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import { hasCertifiedTranscriptNavigation } from "./session-transcript-navigation.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";

it.each([false, true])(
  "preserves closed read-only search before and after navigation migration (shared: %s)",
  async (shared) => {
    await withOpenClawTestState({ label: "search-navigation-upgrade" }, async (state) => {
      const agentId = shared ? "beta" : "main";
      const ownerId = shared ? "alpha" : "main";
      const storePath = shared ? state.path("shared.sqlite") : undefined;
      const databasePath = storePath ?? resolveOpenClawAgentSqlitePath({ agentId, env: state.env });
      const options = { agentId: ownerId, env: state.env, path: databasePath };
      openOpenClawAgentDatabase(options);
      const sessionId = "navigation-upgrade";
      const sessionKey = `agent:${agentId}:navigation-upgrade`;
      await appendTranscriptMessage(
        { agentId, env: state.env, sessionId, sessionKey, storePath },
        { message: { role: "user", content: [{ type: "text", text: "readonly upgrade needle" }] } },
      );
      await waitForSessionTranscriptIndexReconcile(options);
      closeOpenClawAgentDatabasesForTest();

      // Reconstruct the preceding schema-20 shape; writable startup alone installs the additions.
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      let raw;
      try {
        legacy.exec(
          "DROP INDEX idx_agent_transcript_navigation_pending; ALTER TABLE transcript_events DROP COLUMN navigation_json; ALTER TABLE transcript_rewrite_watermarks DROP COLUMN navigation_generation;",
        );
        raw = legacy
          .prepare(
            "SELECT seq, CAST(event_json AS BLOB) AS bytes FROM transcript_events ORDER BY seq",
          )
          .all();
      } finally {
        legacy.close();
      }
      const search = () =>
        searchSessionTranscripts({ agentId, env: state.env, query: "needle", storePath });
      try {
        expect(search()).toMatchObject({
          hits: [expect.objectContaining({ sessionId, sessionKey })],
          indexing: false,
        });
        expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
        const readonly = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(
            readonly
              .prepare("PRAGMA table_info(transcript_events)")
              .all()
              .map((row) => row.name),
          ).not.toContain("navigation_json");
        } finally {
          readonly.close();
        }
      } finally {
        openOpenClawAgentDatabase(options);
      }
      const migrated = openOpenClawAgentDatabase(options);
      expect(
        migrated.db
          .prepare("PRAGMA table_info(transcript_events)")
          .all()
          .map((row) => row.name),
      ).toContain("navigation_json");
      expect(listSessionsNeedingTranscriptIndexReconcile(migrated.db)).toContain(sessionId);
      await reconcileSessionTranscriptIndexes(options);
      expect(hasCertifiedTranscriptNavigation(migrated.db, sessionId)).toBe(true);
      expect(
        migrated.db
          .prepare(
            "SELECT seq, CAST(event_json AS BLOB) AS bytes FROM transcript_events ORDER BY seq",
          )
          .all(),
      ).toEqual(raw);
      closeOpenClawAgentDatabasesForTest();
      expect(search()).toMatchObject({
        hits: [expect.objectContaining({ sessionId, sessionKey })],
        indexing: false,
      });
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
    });
  },
);
