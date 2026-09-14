import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  BEFORE_RESET_HOOK_MAX_BYTES,
  BEFORE_RESET_HOOK_MAX_MESSAGES,
  readBeforeResetHookMessages,
} from "./session-reset-hook-messages.js";

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
      message: { role: index % 2 === 0 ? "user" : "assistant", content: content(index + 1) },
    }));
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      ...events.map((event, index) => ({ ...event, parentId: events[index - 1]?.id ?? null })),
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
    expect(JSON.stringify(payload.messages).length).toBeLessThanOrEqual(
      BEFORE_RESET_HOOK_MAX_BYTES + count * 1024,
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
});
