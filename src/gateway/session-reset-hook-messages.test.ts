import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { selectSessionTranscriptLeafControlledPath } from "../config/sessions/transcript-tree.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readBeforeResetHookMessages } from "./session-reset-hook-messages.js";

// Public hook limits are asserted independently of production constants.
const BEFORE_RESET_HOOK_MAX_MESSAGES = 4096;
const BEFORE_RESET_HOOK_MAX_BYTES = 8 * 1024 * 1024;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function messageIds(messages: unknown[]) {
  return messages.map((entry) => (entry as { __openclaw: { id: string } })["__openclaw"].id);
}

describe("readBeforeResetHookMessages", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = tempDirs.make("openclaw-before-reset-hook-");
    storePath = path.join(tempDir, "sessions.json");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  async function writeTranscript(
    sessionId: string,
    count: number,
    content = (i: number) => `turn ${i}`,
  ) {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    const events = Array.from({ length: count }, (_, index) => ({
      type: "message" as const,
      id: `m${index + 1}`,
      parentId: index === 0 ? null : `m${index}`,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: content(index + 1) },
    }));
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      ...events,
    ]);
    // Large replacements rebuild the transcript projection asynchronously.
    await waitForSessionTranscriptProjection(scope);
    return scope;
  }

  test("delivers every message of a small session unchanged", async () => {
    const scope = await writeTranscript("small", 3);
    const payload = await readBeforeResetHookMessages(scope);
    expect(messageIds(payload.messages)).toEqual(["m1", "m2", "m3"]);
    expect(payload.totalMessages).toBe(3);
    expect(payload.truncated).toBe(false);
  });

  test("keeps only the newest messages of a session above the count bound", async () => {
    const extra = 50;
    const scope = await writeTranscript("large", BEFORE_RESET_HOOK_MAX_MESSAGES + extra);
    const payload = await readBeforeResetHookMessages(scope);
    expect(payload.messages).toHaveLength(BEFORE_RESET_HOOK_MAX_MESSAGES);
    const ids = messageIds(payload.messages);
    expect(ids[0]).toBe(`m${extra + 1}`);
    expect(ids.at(-1)).toBe(`m${BEFORE_RESET_HOOK_MAX_MESSAGES + extra}`);
    expect(payload.totalMessages).toBe(BEFORE_RESET_HOOK_MAX_MESSAGES + extra);
    expect(payload.truncated).toBe(true);
  });

  test("keeps the newest messages within the byte bound", async () => {
    const count = 20;
    const oneMebibyte = "x".repeat(1024 * 1024);
    const scope = await writeTranscript("bulky", count, () => oneMebibyte);
    const payload = await readBeforeResetHookMessages(scope);
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.messages.length).toBeLessThan(count);
    expect(Buffer.byteLength(JSON.stringify(payload.messages), "utf8")).toBeLessThanOrEqual(
      BEFORE_RESET_HOOK_MAX_BYTES,
    );
    expect(messageIds(payload.messages).at(-1)).toBe(`m${count}`);
    expect(payload.totalMessages).toBe(count);
    expect(payload.truncated).toBe(true);
  });

  test("fires with an empty payload when the session identity is incomplete", async () => {
    await expect(
      readBeforeResetHookMessages({ agentId: "main", sessionKey: "agent:main:x", storePath }),
    ).resolves.toEqual({ messages: [], totalMessages: 0, truncated: false });
    await expect(
      readBeforeResetHookMessages({ agentId: "main", sessionId: "x", sessionKey: "agent:main:x" }),
    ).resolves.toEqual({ messages: [], totalMessages: 0, truncated: false });
  });

  test("fires with an empty payload when the transcript cannot be read", async () => {
    const payload = await readBeforeResetHookMessages({
      agentId: "main",
      sessionId: "missing",
      sessionKey: "agent:main:missing",
      storePath,
    });
    expect(payload).toEqual({ messages: [], totalMessages: 0, truncated: false });
  });

  test.each(["display", "raw"] as const)(
    "rejects an oversized newest %s row before parsing",
    async (selection) => {
      const scope = await writeTranscript("oversized", 1, () =>
        "x".repeat(BEFORE_RESET_HOOK_MAX_BYTES + 1),
      );
      const parse = JSON.parse;
      const oversizedReads: number[] = [];
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (Buffer.byteLength(text, "utf8") > BEFORE_RESET_HOOK_MAX_BYTES) {
          oversizedReads.push(text.length);
        }
        return parse(text, reviver);
      });
      try {
        expect(await readBeforeResetHookMessages(scope, selection)).toEqual({
          messages: [],
          totalMessages: 1,
          truncated: true,
        });
        expect(oversizedReads).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    },
  );

  test("does not share mutable empty payloads between observers", async () => {
    const first = await readBeforeResetHookMessages({});
    first.messages.push({ private: "previous observer" });
    expect(await readBeforeResetHookMessages({})).toEqual({
      messages: [],
      totalMessages: 0,
      truncated: false,
    });
  });

  test.each([false, true])(
    "preserves raw command membership across reset, compaction and custom records (leaf=%s)",
    async (withLeaf) => {
      const scope = await writeTranscript("membership", 0);
      const message = (id: string, parentId: string | null) => ({
        type: "message",
        id,
        parentId,
        message: { role: "user", content: id },
      });
      const events = [
        { type: "session", version: 3, id: scope.sessionId },
        message("before", null),
        { type: "reset", id: "reset", parentId: "before", reason: "new" },
        message("after", "reset"),
        {
          type: "compaction",
          id: "compact",
          parentId: "after",
          summary: "summary",
          firstKeptEntryId: "after",
          tokensBefore: 10,
        },
        {
          type: "custom_message",
          id: "custom",
          parentId: "compact",
          customType: "notice",
          display: true,
          content: "custom",
        },
        message("latest", "custom"),
        ...(withLeaf
          ? [
              message("discarded", "latest"),
              { type: "leaf", id: "leaf", parentId: "discarded", targetId: "latest" },
            ]
          : []),
      ];
      await replaceTranscriptEvents(scope, events);
      await waitForSessionTranscriptProjection(scope);
      const raw = await loadTranscriptEvents(scope);
      const expected = (selectSessionTranscriptLeafControlledPath(raw) ?? raw).flatMap((row) => {
        const entry = asOptionalRecord(row);
        return entry?.type === "message" && entry.message ? [entry.message] : [];
      });
      const result = await readBeforeResetHookMessages(scope, "raw");
      expect(result.messages).toEqual(expected);
      expect(result.messages).toEqual(
        ["before", "after", "latest"].map((content) => ({ role: "user", content })),
      );
      expect(result.totalMessages).toBe(expected.length);
      expect(result.truncated).toBe(false);
    },
  );

  test("preserves flat storage membership without leaf controls", async () => {
    const scope = await writeTranscript("flat", 0);
    const messages = ["root", "branch-a", "branch-b"].map((content) => ({ role: "user", content }));
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      { type: "message", id: "root", parentId: null, message: messages[0] },
      { type: "message", id: "a", parentId: "root", message: messages[1] },
      { type: "message", id: "b", parentId: "root", message: messages[2] },
    ]);
    await waitForSessionTranscriptProjection(scope);
    expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
      messages,
      totalMessages: 3,
      truncated: false,
    });
  });
  test("excludes missing and falsy raw payloads before counting and limiting", async () => {
    const scope = await writeTranscript("falsy", 0);
    const valid = { role: "user", content: "keep me" };
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      { type: "message", id: "valid", message: valid },
      ...Array.from({ length: 4100 }, (_, i) => ({
        type: "message",
        id: "null-" + i,
        message: null,
      })),
      { type: "message", id: "missing" },
      { type: "message", id: "empty", message: "" },
      { type: "message", id: "false", message: false },
      { type: "message", id: "zero", message: 0 },
    ]);
    await waitForSessionTranscriptProjection(scope);
    expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
      messages: [valid],
      totalMessages: 1,
      truncated: false,
    });
  });
  test.each([
    { name: "missing target", targetId: "missing" },
    { name: "missing append parent", targetId: "root", appendParentId: "missing" },
    { name: "future target", targetId: "future" },
  ])(
    "ignores an unaccepted leaf control ($name) when selecting raw hook messages",
    async (control) => {
      const scope = await writeTranscript("dangling-leaf", 0);
      const events = [
        { type: "session", version: 3, id: scope.sessionId },
        { type: "message", id: "root", parentId: null, message: { role: "user", content: "root" } },
        { type: "message", id: "a", parentId: "root", message: { role: "user", content: "a" } },
        { type: "message", id: "b", parentId: "root", message: { role: "user", content: "b" } },
        {
          type: "leaf",
          id: "invalid",
          parentId: "b",
          targetId: control.targetId,
          ...("appendParentId" in control ? { appendParentId: control.appendParentId } : {}),
        },
        { type: "custom", id: "future", parentId: "b" },
      ];
      await replaceTranscriptEvents(scope, events);
      await waitForSessionTranscriptProjection(scope);
      const raw = await loadTranscriptEvents(scope);
      expect(selectSessionTranscriptLeafControlledPath(raw)).toBeUndefined();
      expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
        messages: ["root", "a", "b"].map((content) => ({ role: "user", content })),
        totalMessages: 3,
        truncated: false,
      });
    },
  );
  test.each([
    { state: "dirty", leaf: false },
    { state: "missing", leaf: false },
    { state: "lagging", leaf: false },
    { state: "dirty", leaf: true },
    { state: "missing", leaf: true },
    { state: "lagging", leaf: true },
  ])(
    "captures raw command preparation with a $state projection (leaf=$leaf)",
    async ({ state, leaf }) => {
      const scope = await writeTranscript("pending-index", 3);
      if (leaf) {
        const raw = await loadTranscriptEvents(scope);
        await replaceTranscriptEvents(scope, [
          ...raw,
          { type: "leaf", id: "selected", parentId: "m3", targetId: "m1" },
        ]);
      }
      const options = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
      const database = openOpenClawAgentDatabase(options);
      if (state === "missing") {
        database.db
          .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
          .run(scope.sessionId);
      } else if (state === "lagging") {
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET indexed_seq = -1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
      } else {
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
      }
      const { readBeforeResetMessages } =
        await import("../auto-reply/reply/commands-reset-hooks.js");
      try {
        // Mirror reset preparation's writer admission. No readiness wait precedes
        // capture, and an attempted wait inside this callback would deadlock.
        const payload = await runOpenClawAgentWriteAdmission(options, () =>
          readBeforeResetMessages(scope),
        );
        expect(payload).toEqual({
          messages: Array.from({ length: leaf ? 1 : 3 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: "turn " + (index + 1),
          })),
          totalMessages: leaf ? 1 : 3,
          truncated: false,
        });
      } finally {
        // Drain only after the preparation reader has returned and released its
        // writer admission; this is cleanup, not fixture readiness for the test.
        await waitForSessionTranscriptProjection(scope);
      }
    },
  );
  test("uses a session-and-sequence identity lookup without ANALYZE", async () => {
    const scope = await writeTranscript("raw-query-plan", 20);
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const prepare = vi.spyOn(database.db, "prepare");
    let countSql: string | undefined;
    try {
      expect((await readBeforeResetHookMessages(scope, "raw")).messages).toHaveLength(20);
      countSql = prepare.mock.calls
        .map(([statement]) => statement)
        .find((statement) =>
          statement.startsWith('select count(*) as "count" from "transcript_events" as "event"'),
        );
    } finally {
      prepare.mockRestore();
    }
    expect(countSql).toBeDefined();
    if (!countSql) {
      throw new Error("Missing raw hook count query");
    }
    const plan = database.db
      .prepare("EXPLAIN QUERY PLAN " + countSql)
      .all(...Array.from({ length: countSql.match(/\?/g)?.length ?? 0 }, () => null));
    expect(
      plan.some((row) => {
        const detail = asOptionalRecord(row)?.detail;
        return (
          typeof detail === "string" &&
          detail.includes("idx_agent_transcript_event_identity_sequence") &&
          detail.includes("session_id=? AND seq=?")
        );
      }),
    ).toBe(true);
  });
});
