// Emits session lifecycle hooks for channel plugins and agent runtimes.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
  PluginHookSessionStartEvent,
} from "../../plugins/hook-types.js";

/** Session identity attached to plugin session hook payloads. */
type SessionHookContext = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string;
};

function buildSessionHookContext(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
  lifecycleRevision?: string;
}): SessionHookContext {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg }),
    lifecycleRevision: params.lifecycleRevision,
  };
}

/** Builds the payload for plugin session-start hooks. */
export function buildSessionStartHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
  lifecycleRevision?: string;
  resumedFrom?: string;
}): {
  event: PluginHookSessionStartEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      lifecycleRevision: params.lifecycleRevision,
      resumedFrom: params.resumedFrom,
    },
    context: buildSessionHookContext({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      lifecycleRevision: params.lifecycleRevision,
    }),
  };
}

/** Builds the payload for plugin session-end hooks. */
export function buildSessionEndHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
  messageCount?: number;
  durationMs?: number;
  reason?: PluginHookSessionEndReason;
  sessionFile?: string;
  transcriptArchived?: boolean;
  lifecycleRevision?: string;
  nextSessionId?: string;
  nextSessionKey?: string;
  nextLifecycleRevision?: string;
}): {
  event: PluginHookSessionEndEvent;
  context: SessionHookContext;
} {
  return {
    event: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      lifecycleRevision: params.lifecycleRevision,
      messageCount: params.messageCount ?? 0,
      durationMs: params.durationMs,
      reason: params.reason,
      sessionFile: params.sessionFile,
      transcriptArchived: params.transcriptArchived,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
      nextLifecycleRevision: params.nextLifecycleRevision,
    },
    context: buildSessionHookContext({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      lifecycleRevision: params.lifecycleRevision,
    }),
  };
}
