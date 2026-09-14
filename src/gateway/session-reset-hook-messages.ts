// Bounded transcript snapshot delivered to `before_reset` plugin hooks.
import type { SessionEntry } from "../config/sessions/types.js";
import { logVerbose } from "../globals.js";
import { readSessionMessagesWithSourceAsync } from "./session-transcript-readers.js";

/**
 * Newest messages handed to `before_reset` observers. Mirrors the bounded
 * session-memory capture so a reset never materializes an unbounded history:
 * a 1.6M-message session previously took ~118 s and ~15 GiB of heap to build
 * this payload, freezing the Gateway on every `/new`.
 */
export const BEFORE_RESET_HOOK_MAX_MESSAGES = 4_096;
export const BEFORE_RESET_HOOK_MAX_BYTES = 8 * 1024 * 1024;

export type BeforeResetHookMessages = {
  /** Newest transcript messages, oldest first, bounded by count and bytes. */
  messages: unknown[];
  /** Visible message count before bounding; equals `messages.length` when complete. */
  totalMessages: number;
  /** True when older messages were omitted from `messages`. */
  truncated: boolean;
};

const EMPTY_BEFORE_RESET_HOOK_MESSAGES: BeforeResetHookMessages = Object.freeze({
  messages: [],
  totalMessages: 0,
  truncated: false,
});

export type BeforeResetHookMessagesScope = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: Partial<Pick<SessionEntry, "sessionId">>;
};

/**
 * Reads the pre-reset transcript for plugin observers without loading the
 * whole session. Missing identity or read failures fire the hook with an
 * empty payload, matching the previous contract.
 */
export async function readBeforeResetHookMessages(
  scope: BeforeResetHookMessagesScope,
): Promise<BeforeResetHookMessages> {
  const sessionId = typeof scope.sessionId === "string" ? scope.sessionId.trim() : "";
  const sessionKey = typeof scope.sessionKey === "string" ? scope.sessionKey.trim() : "";
  const storePath = typeof scope.storePath === "string" ? scope.storePath.trim() : "";
  if (!sessionId || !sessionKey || !storePath) {
    logVerbose("before_reset: no session identity available, firing hook with empty messages");
    return EMPTY_BEFORE_RESET_HOOK_MESSAGES;
  }
  try {
    const result = await readSessionMessagesWithSourceAsync(
      {
        ...(scope.agentId ? { agentId: scope.agentId } : {}),
        ...(scope.sessionEntry ? { sessionEntry: scope.sessionEntry } : {}),
        sessionId,
        sessionKey,
        storePath,
      },
      {
        mode: "recent",
        maxMessages: BEFORE_RESET_HOOK_MAX_MESSAGES,
        maxBytes: BEFORE_RESET_HOOK_MAX_BYTES,
      },
    );
    const totalMessages = Math.max(
      result.totalMessages ?? result.messages.length,
      result.messages.length,
    );
    return {
      messages: result.messages,
      totalMessages,
      truncated: totalMessages > result.messages.length,
    };
  } catch (err: unknown) {
    logVerbose(
      `before_reset: failed to read session messages for ${sessionKey}/${sessionId}; firing hook with empty messages (${String(err)})`,
    );
    return EMPTY_BEFORE_RESET_HOOK_MESSAGES;
  }
}
