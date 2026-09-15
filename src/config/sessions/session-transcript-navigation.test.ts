import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSessionMemoryTranscript } from "../../hooks/bundled/session-memory/capture.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  upsertSessionEntryCore,
  replaceTranscriptEvents,
  loadReplySessionInitializationSnapshot,
  commitReplySessionInitialization,
} from "./session-accessor.js";
import { readSessionTranscriptMemoryTail } from "./session-accessor.sqlite-memory-tail.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  ensureTranscriptGenerationInTransaction,
  readTranscriptGenerationInTransaction,
  rotateTranscriptGenerationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  rewriteSqliteTranscriptEventRowsInTransaction,
  updateSqliteTranscriptEventJsonInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import {
  markSessionTranscriptIndexDirtyInTransaction,
  listSessionsNeedingTranscriptIndexReconcile,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import {
  encodeTranscriptNavigation,
  decodeTranscriptNavigation,
  hasCertifiedTranscriptNavigation,
  readTranscriptNavigationSnapshot,
  applyTranscriptNavigationChunkInTransaction,
} from "./session-transcript-navigation.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerMessage } from "./session-transcript-reconcile.worker.js";
import { copyRetainedTranscriptPayload } from "./session-transcript-retained-data.js";
import { selectRecentUserAssistantReplayRecords } from "./transcript-replay.js";
import { scanSessionTranscriptTree } from "./transcript-tree.js";

const identities = [
  "\ud800",
  "\ud801",
  "\udc00",
  "\udc01",
  "\ufffd",
  "\ufffd\ufffd\ufffd",
  "日本語🦞",
  "nul\0tail",
  String.fromCharCode(92) + "u0001U",
  String.fromCharCode(92) + "ud800",
  String.fromCharCode(1) + "U0001B",
];
afterEach(() => vi.restoreAllMocks());

describe("lossless raw-sequence navigation", () => {
  it.each(identities)("preserves JSON string code units: %j", (id) => {
    const event = {
      type: "leaf",
      id,
      parentId: id,
      targetId: id,
      appendParentId: id,
      opaque: "excluded-body",
    };
    const encoded = encodeTranscriptNavigation(JSON.stringify(event));
    expect(decodeTranscriptNavigation(encoded)).toEqual({
      type: "leaf",
      id,
      parentId: id,
      targetId: id,
      appendParentId: id,
    });
    expect(encoded).not.toContain("excluded-body");
  });
  it("uses last duplicate members and escaped names while bounding invalid values", () => {
    const raw = String.raw`{"type":"leaf","id":null,"id":"wrong","i\u0064":"last-\ud800","parentId":"wrong","parentId":null,"targetId":"\ud801","appendParentId":{"nested":"\udc00"},"message":{"role":"assistant"},"message":{"role":"user","role":"toolResult","content":"excluded-body"}}`;
    expect(decodeTranscriptNavigation(encodeTranscriptNavigation(raw))).toEqual({
      type: "leaf",
      id: "last-\ud800",
      parentId: null,
      targetId: "\ud801",
      appendParentId: false,
      message: { role: false },
    });
  });
  it.each([
    {},
    { parentId: null },
    { parentId: false },
    { appendParentId: null },
    { message: null },
    { message: {} },
    { message: { role: null } },
  ])("retains presence rather than merge-patching nulls: %j", (fields) => {
    const event = { type: "message", id: "entry", ...fields };
    expect(decodeTranscriptNavigation(encodeTranscriptNavigation(JSON.stringify(event)))).toEqual(
      event,
    );
  });
  it("handles JSON.parse-valid overdepth opaque values without SQLite JSON traversal", () => {
    const raw =
      '{"type":"leaf","id":"leaf","parentId":null,"targetId":null,"opaque":' +
      "[".repeat(1100) +
      "0" +
      "]".repeat(1100) +
      "}";
    expect(decodeTranscriptNavigation(encodeTranscriptNavigation(raw))).toEqual({
      type: "leaf",
      id: "leaf",
      parentId: null,
      targetId: null,
    });
  });
  it.each(["{", '{"type":"message"}\0ignored'])(
    "records malformed raw JSON as terminal poison: %j",
    (raw) => {
      expect(encodeTranscriptNavigation(raw)).toBe("[1]");
      expect(() => decodeTranscriptNavigation(encodeTranscriptNavigation(raw))).toThrow(
        "unavailable",
      );
    },
  );
});

function message(id: string, parentId: string | null, role: string, content: string) {
  return { type: "message", id, parentId, message: { role, content } };
}

async function withTranscript(
  run: (fixture: {
    scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
    options: ReturnType<typeof toDatabaseOptions>;
    database: ReturnType<typeof openOpenClawAgentDatabase>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "navigation" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "navigation",
      sessionKey: "agent:main:navigation",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const options = toDatabaseOptions(resolveSqliteScope(scope));
    const database = openOpenClawAgentDatabase(options);
    try {
      await run({ scope, options, database });
    } finally {
      await waitForSessionTranscriptIndexReconcile(options);
    }
  });
}

it.each([false, true])(
  "makes a real FIRST capture after legacy backfill (reset: %s)",
  async (reset) => {
    await withTranscript(async ({ scope, options, database }) => {
      const excluded = "excluded-body-".repeat(4096);
      const events = [
        { type: "session", id: scope.sessionId, version: 3 },
        message("root", null, "user", "question"),
        message("branch-\ud800", "root", "assistant", "FIRST"),
        message("branch-\ud801", "root", "assistant", excluded),
        { type: "leaf", id: "leaf", parentId: "branch-\ud801", targetId: "branch-\ud800" },
        ...(reset
          ? [
              { type: "reset", id: "reset", parentId: "branch-\ud800", firstKeptEntryId: "root" },
              message("latest", "reset", "user", "current"),
            ]
          : []),
      ];
      runOpenClawAgentWriteTransaction(() => {
        const insert = database.db.prepare(
          "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)",
        );
        for (const [index, event] of events.entries()) {
          insert.run(scope.sessionId, index * 3, JSON.stringify(event), 1);
        }
        ensureTranscriptGenerationInTransaction(database, scope.sessionId);
        markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId);
      }, options);
      const before = database.db
        .prepare("SELECT seq,event_json,created_at FROM transcript_events ORDER BY seq")
        .all();
      const generation = readTranscriptGenerationInTransaction(database, scope.sessionId);
      expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(false);
      expect(captureSessionMemoryTranscript(scope, undefined)).toMatchObject({
        status: "unavailable",
      });
      await waitForSessionTranscriptIndexReconcile(options);
      expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(true);
      expect(readTranscriptGenerationInTransaction(database, scope.sessionId)).toBe(generation);
      expect(
        database.db
          .prepare("SELECT seq,event_json,created_at FROM transcript_events ORDER BY seq")
          .all(),
      ).toEqual(before);
      // Deliberately dirty only the active index. Raw navigation remains available.
      runOpenClawAgentWriteTransaction(
        () => markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId),
        options,
      );
      const parse = JSON.parse;
      let excludedParses = 0;
      vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(excluded)) {
          excludedParses++;
        }
        return parse(text, reviver);
      });
      expect(captureSessionMemoryTranscript(scope, undefined)).toEqual({
        status: "available",
        originClass: "untrusted",
        content: 'user: "question"\nassistant: "FIRST"' + (reset ? '\nuser: "current"' : ""),
      });
      expect(excludedParses).toBe(0);
    });
  },
);

it("repairs navigation-only gaps without rebuilding a healthy active/FTS projection", async () => {
  await withTranscript(async ({ scope, database, options }) => {
    await replaceTranscriptEvents(scope, [
      message("root", null, "user", "question"),
      message("answer", "root", "assistant", "answer"),
    ]);
    await waitForSessionTranscriptIndexReconcile(options);
    const before = database.db.prepare("SELECT * FROM session_transcript_index_state").all();
    database.db.exec("UPDATE transcript_events SET navigation_json=NULL");
    expect(sessionTranscriptIndexNeedsReconcile(database.db, scope.sessionId)).toBe(false);
    expect(listSessionsNeedingTranscriptIndexReconcile(database.db)).toContain(scope.sessionId);
    await reconcileSessionTranscriptIndexes(options);
    expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(true);
    expect(database.db.prepare("SELECT * FROM session_transcript_index_state").all()).toEqual(
      before,
    );
    expect(listSessionsNeedingTranscriptIndexReconcile(database.db)).not.toContain(scope.sessionId);
  });
});

it("invalidates older-writer exact rewrites by generation even when every header remains non-NULL", async () => {
  await withTranscript(async ({ scope, database, options }) => {
    await replaceTranscriptEvents(scope, [
      message("root", null, "user", "question"),
      message("answer", "root", "assistant", "answer"),
    ]);
    await waitForSessionTranscriptIndexReconcile(options);
    const replacement = message("answer", "root", "assistant", "changed");
    runOpenClawAgentWriteTransaction(() => {
      database.db
        .prepare("UPDATE transcript_events SET event_json=? WHERE session_id=? AND seq=1")
        .run(JSON.stringify(replacement), scope.sessionId);
      // The released v2026.9.4 owner rotates these fields, without knowing the new column.
      database.db
        .prepare(
          "UPDATE transcript_rewrite_watermarks SET generation='older-writer-generation', updated_at=2 WHERE session_id=?",
        )
        .run(scope.sessionId);
      markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId);
    }, options);
    expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(false);
    expect(captureSessionMemoryTranscript(scope, undefined)).toMatchObject({
      status: "unavailable",
    });
    await waitForSessionTranscriptIndexReconcile(options);
    expect(captureSessionMemoryTranscript(scope, undefined)).toMatchObject({
      status: "available",
      content: 'user: "question"\nassistant: "changed"',
    });
  });
});

it("maintains headers on current exact rewrites and rejects raced or byte-different repair chunks", async () => {
  await withTranscript(async ({ scope, database, options }) => {
    const original = message("root", null, "user", "question");
    await replaceTranscriptEvents(scope, [original]);
    const resolved = {
      ...resolveSqliteScope(scope),
      sessionId: scope.sessionId,
      sessionKey: scope.sessionKey,
    };
    const updated = message("root", null, "assistant", "answer");
    runOpenClawAgentWriteTransaction(
      () =>
        rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, [
          { event: updated, expectedEventJson: JSON.stringify(original), seq: 0 },
        ]),
      options,
    );
    expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(true);
    const snapshot = readTranscriptNavigationSnapshot(database.db, scope.sessionId)!;
    expect(() =>
      runOpenClawAgentWriteTransaction(
        () =>
          applyTranscriptNavigationChunkInTransaction(database.db, snapshot, [
            {
              seq: 0,
              sourceBytes: Buffer.from(JSON.stringify(updated) + " "),
              navigationJson: "[1,null]",
            },
          ]),
        options,
      ),
    ).toThrow("changed during navigation repair");
    runOpenClawAgentWriteTransaction(
      () => rotateTranscriptGenerationInTransaction(database, scope.sessionId),
      options,
    );
    expect(
      runOpenClawAgentWriteTransaction(
        () =>
          applyTranscriptNavigationChunkInTransaction(database.db, snapshot, [
            {
              seq: 0,
              sourceBytes: Buffer.from(JSON.stringify(updated)),
              navigationJson: "[1,null]",
            },
          ]),
        options,
      ),
    ).toBe(false);
    runOpenClawAgentWriteTransaction(
      () =>
        updateSqliteTranscriptEventJsonInTransaction(database, scope.sessionId, [
          { seq: 0, eventJson: JSON.stringify(original) },
        ]),
      options,
    );
    await reconcileSessionTranscriptIndexes(options);
    expect(readSessionTranscriptMemoryTail(scope, { maxBytes: 1024, maxMessages: 10 })).toEqual([
      original,
    ]);
  });
});

it("copies retained metadata without copying physical seq and invalidates SQL reparenting", async () => {
  await withTranscript(async ({ scope, database, options }) => {
    await replaceTranscriptEvents(scope, [
      { type: "custom", id: "custom", parentId: null, data: { opaque: "payload" } },
    ]);
    runOpenClawAgentWriteTransaction(() => {
      copyRetainedTranscriptPayload(database, scope.sessionId, 0, 7);
      copyRetainedTranscriptPayload(database, scope.sessionId, 0, 9, "new-parent");
    }, options);
    const rows = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", "navigation_json"])
        .orderBy("seq"),
    ).rows;
    expect(rows[1]?.navigation_json).toBe(rows[0]?.navigation_json);
    expect(decodeTranscriptNavigation(rows[1]!.navigation_json)).not.toHaveProperty("seq");
    expect(rows[2]?.navigation_json).toBeNull();
    expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(false);
    await reconcileSessionTranscriptIndexes(options);
    expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(true);
    const repaired = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select("navigation_json")
        .where("seq", "=", 9),
    ).rows[0]!;
    expect(decodeTranscriptNavigation(repaired.navigation_json)).toMatchObject({
      parentId: "new-parent",
    });
  });
});

it("commits bounded legacy header chunks without touching FTS or raw generation", async () => {
  await withTranscript(async ({ scope, database, options }) => {
    await replaceTranscriptEvents(
      scope,
      Array.from({ length: 1_200 }, (_, index) =>
        message(String(index), index ? String(index - 1) : null, "user", "x".repeat(512)),
      ),
    );
    await waitForSessionTranscriptIndexReconcile(options);
    const generation = readTranscriptGenerationInTransaction(database, scope.sessionId);
    const state = database.db.prepare("SELECT * FROM session_transcript_index_state").all();
    database.db.exec("UPDATE transcript_events SET navigation_json=NULL");
    const chunks: { rows: number; bytes: number }[] = [];
    let projectionPlans = 0;
    await reconcileSessionTranscriptIndexes({
      ...options,
      createWorker: (filename, workerOptions) => {
        const worker = new Worker(filename, workerOptions);
        worker.on("message", (event: SessionTranscriptReconcileWorkerMessage) => {
          if (event.type === "navigation-chunk") {
            chunks.push({
              rows: event.rows.length,
              bytes: event.rows.reduce((sum, row) => sum + row.sourceBytes.byteLength, 0),
            });
          }
          if (event.type === "plan-start") {
            projectionPlans++;
          }
        });
        return worker;
      },
    });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.reduce((sum, chunk) => sum + chunk.rows, 0)).toBe(1_200);
    expect(chunks.every((chunk) => chunk.rows <= 512 && chunk.bytes <= 256 * 1024)).toBe(true);
    expect(projectionPlans).toBe(0);
    expect(database.db.prepare("SELECT * FROM session_transcript_index_state").all()).toEqual(
      state,
    );
    expect(readTranscriptGenerationInTransaction(database, scope.sessionId)).toBe(generation);
    expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(true);
  });
});

it("records NUL-tainted raw bytes as poison once instead of certifying a truncated prefix", async () => {
  await withTranscript(async ({ scope, database, options }) => {
    await replaceTranscriptEvents(scope, [message("root", null, "user", "before")]);
    const raw = Buffer.from(JSON.stringify(message("root", null, "user", "after")) + "\0ignored");
    database.db
      .prepare("UPDATE transcript_events SET event_json=CAST(? AS TEXT), navigation_json=NULL")
      .run(raw);
    await reconcileSessionTranscriptIndexes(options);
    const row = database.db
      .prepare("SELECT navigation_json, CAST(event_json AS BLOB) AS raw FROM transcript_events")
      .get();
    expect(row?.navigation_json).toBe("[1]");
    expect(row?.raw).toEqual(Uint8Array.from(raw));
    expect(listSessionsNeedingTranscriptIndexReconcile(database.db)).toEqual([]);
    expect(() =>
      readSessionTranscriptMemoryTail(scope, { maxBytes: 1024, maxMessages: 10 }),
    ).toThrow("unavailable");
    expect(await reconcileSessionTranscriptIndexes(options)).toEqual({ reconciledSessions: 0 });
  });
});

function navigationDecisions(entries: unknown[]) {
  const tree = scanSessionTranscriptTree(entries);
  const reset = buildSessionResetBoundaryEvent({
    events: entries,
    context: "clear",
    reason: "reset",
  });
  return {
    leafId: tree.leafId,
    appendParentId: tree.appendParentId,
    nodes: tree.nodes.map(({ id, parentId, leafId, appendParentId }) => ({
      id,
      parentId,
      leafId,
      appendParentId,
    })),
    resetParent: reset.parentId,
  };
}

it.each([
  "parentId",
  "targetId",
  "appendParentId",
  "appendMode",
  "id",
  "type",
  "timestamp",
  "firstKeptEntryId",
])("retains invalid overflowing-number semantics for %s", (key) => {
  const root = message("root", null, "user", "question");
  const raw = JSON.stringify({
    type: "leaf",
    id: "control",
    parentId: "root",
    targetId: "root",
    appendParentId: "root",
    [key]: "overflow",
  }).replace(JSON.stringify("overflow"), "1e400");
  const original: unknown = JSON.parse(raw);
  const projected = decodeTranscriptNavigation(encodeTranscriptNavigation(raw));
  expect(navigationDecisions([root, projected])).toEqual(navigationDecisions([root, original]));
});

it.each([
  "parentId",
  "targetId",
  "appendParentId",
  "appendMode",
  "id",
  "type",
  "timestamp",
  "firstKeptEntryId",
])("bounds opaque invalid navigation values without changing decisions: %s", (key) => {
  const payload = "opaque-navigation-payload".repeat(50000);
  const original = {
    type: "leaf",
    id: "control",
    parentId: "root",
    targetId: "root",
    appendParentId: "root",
    [key]: { payload },
  };
  const encoded = encodeTranscriptNavigation(JSON.stringify(original));
  expect(encoded.length).toBeLessThan(512);
  expect(encoded).not.toContain(payload);
  const root = message("root", null, "user", "question");
  expect(navigationDecisions([root, decodeTranscriptNavigation(encoded)])).toEqual(
    navigationDecisions([root, original]),
  );
});

it("never acquires an excluded opaque invalid parent or role before the payload budget", async () => {
  await withTranscript(async ({ scope, options, database }) => {
    const payload = "opaque-excluded-navigation".repeat(50000);
    const root = message("root", null, "user", "question");
    await replaceTranscriptEvents(scope, [
      root,
      {
        type: "message",
        id: "excluded",
        parentId: { payload },
        message: { role: { payload }, content: payload },
      },
    ]);
    await waitForSessionTranscriptIndexReconcile(options);
    runOpenClawAgentWriteTransaction(
      () => markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId),
      options,
    );
    const headers = database.db.prepare("SELECT navigation_json FROM transcript_events").all();
    expect(
      headers.every(
        (row) => typeof row.navigation_json === "string" && row.navigation_json.length < 512,
      ),
    ).toBe(true);
    const parse = JSON.parse;
    let acquired = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes(payload)) {
        acquired++;
      }
      return parse(text, reviver);
    });
    expect(readSessionTranscriptMemoryTail(scope, { maxBytes: 256, maxMessages: 10 })).toEqual([
      root,
    ]);
    expect(acquired).toBe(0);
  });
});

it("does not strip a leading BOM into a valid control during backfill", async () => {
  await withTranscript(async ({ scope, database, options }) => {
    await replaceTranscriptEvents(scope, [message("root", null, "user", "question")]);
    const raw = Buffer.from(
      String.fromCharCode(0xfeff) +
        JSON.stringify({ type: "leaf", id: "control", parentId: null, targetId: null }),
    );
    database.db
      .prepare("UPDATE transcript_events SET event_json=CAST(? AS TEXT), navigation_json=NULL")
      .run(raw);
    expect(encodeTranscriptNavigation(raw.toString("utf8"))).toBe("[1]");
    await reconcileSessionTranscriptIndexes(options);
    const row = database.db
      .prepare("SELECT navigation_json, CAST(event_json AS BLOB) AS raw FROM transcript_events")
      .get();
    expect(row?.navigation_json).toBe("[1]");
    expect(row?.raw).toEqual(Uint8Array.from(raw));
    expect(listSessionsNeedingTranscriptIndexReconcile(database.db)).toEqual([]);
    expect(() =>
      readSessionTranscriptMemoryTail(scope, { maxBytes: 256, maxMessages: 10 }),
    ).toThrow("unavailable");
  });
});

async function clearLikeOlderWriter(fixture: Parameters<Parameters<typeof withTranscript>[0]>[0]) {
  const { scope, database, options } = fixture;
  await replaceTranscriptEvents(scope, [message("root", null, "user", "question")]);
  await waitForSessionTranscriptIndexReconcile(options);
  runOpenClawAgentWriteTransaction(() => {
    database.db.prepare("DELETE FROM transcript_events WHERE session_id=?").run(scope.sessionId);
    database.db
      .prepare(
        "UPDATE transcript_rewrite_watermarks SET generation=?,updated_at=2 WHERE session_id=?",
      )
      .run("older-empty-generation", scope.sessionId);
    markSessionTranscriptIndexDirtyInTransaction(database.db, scope.sessionId);
  }, options);
}

it("reads empty navigation after an older writer clears history and leaves a stale certificate", async () => {
  await withTranscript(async (fixture) => {
    await clearLikeOlderWriter(fixture);
    expect(
      loadTranscriptEventsFromDatabase(fixture.database, fixture.scope.sessionId, {
        projection: "reset-boundary",
      }),
    ).toEqual([]);
    expect(
      readSessionTranscriptMemoryTail(fixture.scope, { maxBytes: 256, maxMessages: 10 }),
    ).toEqual([]);
  });
});

it("commits a real reset after older-writer empty history without certifying stale facts", async () => {
  await withTranscript(async (fixture) => {
    await clearLikeOlderWriter(fixture);
    const { scope, options, database } = fixture;
    const snapshot = loadReplySessionInitializationSnapshot(scope);
    expect(snapshot.currentEntry).toBeDefined();
    const result = await commitReplySessionInitialization({
      ...scope,
      activeSessionKey: scope.sessionKey,
      archivePreviousTranscript: false,
      expectedRevision: snapshot.revision,
      sessionEntry: snapshot.currentEntry!,
      resetBoundary: { context: "clear", reason: "reset", cwd: path.dirname(scope.storePath) },
    });
    expect(result.ok).toBe(true);
    expect(hasCertifiedTranscriptNavigation(database.db, scope.sessionId)).toBe(true);
    const last = database.db
      .prepare(
        "SELECT event_json FROM transcript_events WHERE session_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(scope.sessionId);
    expect(JSON.parse(String(last?.event_json))).toMatchObject({ type: "reset", parentId: null });
    await waitForSessionTranscriptIndexReconcile(options);
  });
});

it.each(["role", "appendMode", "type"])(
  "bounds unsupported string-valued navigation enums: %s",
  (kind) => {
    const payload = "UNRECOGNIZED_ENUM_".repeat(100000);
    const root = { ...message("root", null, "user", "question"), timestamp: 1 };
    const event =
      kind === "role"
        ? { ...message("entry", "root", payload, "not replayed"), timestamp: 1 }
        : { type: "leaf", id: "control", parentId: "root", targetId: "root", [kind]: payload };
    const encoded = encodeTranscriptNavigation(JSON.stringify(event));
    expect(encoded.length).toBeLessThan(512);
    expect(encoded).not.toContain(payload);
    const projected = decodeTranscriptNavigation(encoded);
    expect(navigationDecisions([root, projected])).toEqual(navigationDecisions([root, event]));
  },
);

it.each([" ", "meaningful"])(
  "bounds timestamp text while preserving replay eligibility: %s",
  (text) => {
    const root = { ...message("root", null, "user", "question"), timestamp: 1 };
    const event = {
      ...message("answer", "root", "assistant", "answer"),
      timestamp: text.repeat(200000),
    };
    const encoded = encodeTranscriptNavigation(JSON.stringify(event));
    expect(encoded.length).toBeLessThan(512);
    const projected = decodeTranscriptNavigation(encoded);
    const ids = (entries: unknown[]) =>
      selectRecentUserAssistantReplayRecords(entries).map((entry) => (entry as { id: string }).id);
    expect(ids([root, projected])).toEqual(ids([root, event]));
  },
);
