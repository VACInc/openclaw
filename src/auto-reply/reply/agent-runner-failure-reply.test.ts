import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildEmptyInteractiveReplyPayload,
  buildSessionsYieldStatusReplyPayload,
} from "./agent-runner-failure-reply.js";

const EMPTY_INTERACTIVE_REPLY_TEXT =
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.";

describe("buildEmptyInteractiveReplyPayload", () => {
  const baseParams = {
    isInteractive: true,
    isMessageToolOnly: false,
    hasPendingContinuation: false,
    hasExplicitSilentReply: false,
    hasCommittedDelivery: false,
    sessionCtx: {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    },
  } as const;

  it("preserves the default silent policy in group conversations", () => {
    const payload = buildEmptyInteractiveReplyPayload(baseParams);

    expect(payload?.text).toBe(SILENT_REPLY_TOKEN);
    expect(payload?.isError).toBeUndefined();
  });

  it("surfaces the fallback when group silence is explicitly disallowed", () => {
    expect(
      buildEmptyInteractiveReplyPayload({
        ...baseParams,
        cfg: { agents: { defaults: { silentReply: { group: "disallow" } } } },
      }),
    ).toMatchObject({ text: EMPTY_INTERACTIVE_REPLY_TEXT, isError: true });
  });
});

describe("buildSessionsYieldStatusReplyPayload", () => {
  const baseParams = {
    yielded: true,
    yieldMessage: "Research started; results will follow.",
    isInteractive: true,
    isMessageToolOnly: false,
    hasExplicitSilentReply: false,
    hasVisibleReplyDelivery: false,
  } as const;

  it("returns the explicit waiting status for an interactive yielded turn", () => {
    expect(buildSessionsYieldStatusReplyPayload(baseParams)).toEqual({
      text: "Research started; results will follow.",
    });
  });

  it("requires a non-empty explicit message", () => {
    expect(
      buildSessionsYieldStatusReplyPayload({ ...baseParams, yieldMessage: undefined }),
    ).toBeUndefined();
    expect(
      buildSessionsYieldStatusReplyPayload({ ...baseParams, yieldMessage: "   " }),
    ).toBeUndefined();
  });

  it.each([
    { yielded: false },
    { isInteractive: false },
    { isHeartbeat: true },
    { silentExpected: true },
    { allowEmptyAssistantReplyAsSilent: true },
    { isMessageToolOnly: true },
    { hasExplicitSilentReply: true },
    { hasVisibleReplyDelivery: true },
  ])("stays silent for $0", (override) => {
    expect(buildSessionsYieldStatusReplyPayload({ ...baseParams, ...override })).toBeUndefined();
  });
});
