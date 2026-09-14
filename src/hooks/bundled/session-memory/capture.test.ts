import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as accessor from "../../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../../config/sessions/session-transcript-read-fence.js";
import { appendSessionTranscriptMessageByIdentity } from "../../../plugin-sdk/session-transcript-runtime.js";
import { captureSessionMemoryTranscript } from "./capture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function message(id: string, parentId: string | null, role: string, content = id) {
  return { type: "message", id, parentId, message: { role, content } };
}

describe("session memory capture", () => {
  let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };

  beforeEach(() => {
    scope = {
      agentId: "main",
      sessionId: "capture",
      sessionKey: "agent:main:capture",
      storePath: path.join(tempDirs.make("openclaw-memory-capture-"), "sessions.json"),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  async function captureReady() {
    await accessor.waitForSessionTranscriptProjection(scope);
    return captureSessionMemoryTranscript(scope, undefined);
  }

  function captureDuringRepair() {
    vi.spyOn(accessor, "readSessionTranscriptBoundedMessageTailPage").mockImplementation(() => {
      throw new accessor.SessionTranscriptProjectionUnavailableError(scope.sessionId);
    });
    return captureSessionMemoryTranscript(scope, undefined);
  }

  it("keeps repair capture before the admitted current turn", async () => {
    await accessor.upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const prior = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "prior answer" },
    });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      parentId: prior?.messageId,
      message: { role: "user", content: "current request" },
    });
    if (!admitted?.anchor) {
      throw new Error("expected a current-turn transcript anchor");
    }
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      parentId: admitted.messageId,
      message: { role: "assistant", content: "current answer" },
    });
    await accessor.waitForSessionTranscriptProjection(scope);
    const receipt = { ...admitted.anchor, logicalTurnId: "memory-fence", role: "user" as const };
    expect(runWithSessionTranscriptReadFence(receipt, captureDuringRepair)).toEqual({
      status: "available",
      originClass: "untrusted",
      content: 'assistant: "prior answer"',
    });
    expect(
      runWithSessionTranscriptReadFence(
        { ...receipt, rawSeq: receipt.rawSeq + 1 },
        captureDuringRepair,
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it.each(
    [false, true].flatMap((preserve) =>
      [false, true].map((compacted) => ({ preserve, compacted })),
    ),
  )(
    "respects an earlier reset (preserve: $preserve, compacted: $compacted)",
    async ({ preserve, compacted }) => {
      await accessor.replaceTranscriptEvents(scope, [
        message("closed", null, "user"),
        message("kept", "closed", "user"),
        message("answer", "kept", "assistant"),
        message("tool", "answer", "toolResult"),
        {
          type: "reset",
          id: "reset",
          parentId: "tool",
          ...(preserve ? { firstKeptEntryId: "kept" } : {}),
        },
        ...(compacted
          ? [
              {
                type: "compaction",
                id: "compact",
                parentId: "reset",
                firstKeptEntryId: "kept",
                summary: "earlier summary",
              },
            ]
          : []),
        message("current", compacted ? "compact" : "reset", "user"),
      ]);
      const expected = {
        status: "available",
        originClass: "untrusted",
        content: preserve
          ? 'user: "kept"\nassistant: "answer"\nuser: "current"'
          : 'user: "current"',
      };
      expect(await captureReady()).toEqual(expected);
      expect(captureDuringRepair()).toEqual(expected);
    },
  );

  it("spans compaction and selects the explicit branch without changing provenance", async () => {
    const hiddenPayload = "inactive branch payload ".repeat(4_096);
    await accessor.replaceTranscriptEvents(scope, [
      {
        ...message("restricted", null, "user"),
        message: { role: "user", content: "restricted", __openclaw: { senderIsOwner: false } },
      },
      { type: "compaction", id: "compact", parentId: "restricted", summary: "summary" },
      message("chosen", "compact", "assistant"),
      message("other", "compact", "assistant", hiddenPayload),
      { type: "leaf", id: "leaf", parentId: "other", targetId: "chosen" },
    ]);
    const expected = {
      status: "available",
      originClass: "untrusted",
      content: 'user: "restricted"\nassistant: "chosen"',
    };
    expect(await captureReady()).toEqual(expected);
    const parse = JSON.parse;
    let hydratedHiddenPayloads = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes(hiddenPayload)) {
        hydratedHiddenPayloads += 1;
      }
      return parse(text, reviver);
    });
    expect(captureDuringRepair()).toEqual(expected);
    expect(hydratedHiddenPayloads).toBe(0);
  });

  it("does not charge discarded reset-tail tools against the capture budget", async () => {
    await accessor.replaceTranscriptEvents(scope, [
      message("kept", null, "assistant", "k".repeat(1_024)),
      message("tool", "kept", "toolResult", "x".repeat(8 * 1024 * 1024 - 512)),
      { type: "reset", id: "reset", parentId: "tool", firstKeptEntryId: "kept" },
      message("current", "reset", "assistant"),
    ]);
    const captured = await captureReady();
    expect(captured.status === "available" && captured.content?.includes("k".repeat(1_024))).toBe(
      true,
    );
    expect(captureDuringRepair()).toEqual(captured);
  });

  it("skips oversized rows while retaining the bounded recent conversation", async () => {
    await accessor.replaceTranscriptEvents(scope, [
      message("older", null, "assistant"),
      message("oversized", "older", "assistant", "x".repeat(8 * 1024 * 1024)),
      message("latest", "oversized", "assistant"),
    ]);
    const expected = {
      status: "available",
      originClass: "untrusted",
      content: 'assistant: "older"\nassistant: "latest"',
    };
    expect(await captureReady()).toEqual(expected);
    const parse = JSON.parse;
    let hydratedOversizedRows = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && Buffer.byteLength(text) > 8 * 1024 * 1024) {
        hydratedOversizedRows += 1;
      }
      return parse(text, reviver);
    });
    expect(captureDuringRepair()).toEqual(expected);
    expect(hydratedOversizedRows).toBe(0);
  });

  it("does not scan beyond the message cap to fill an excerpt", async () => {
    await accessor.replaceTranscriptEvents(
      scope,
      Array.from({ length: 4_097 }, (_, index) =>
        message(
          String(index),
          index ? String(index - 1) : null,
          "assistant",
          index === 0 ? "beyond the cap" : "NO_REPLY",
        ),
      ),
    );
    const expected = { status: "available", content: null, originClass: "agent" };
    expect(await captureReady()).toEqual(expected);
    expect(captureDuringRepair()).toEqual(expected);
  });
});
