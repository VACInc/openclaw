import { onAgentEvent } from "../infra/agent-events.js";
import { buildInternalHookContext } from "./hook-context.js";
import { createInternalHookEvent, triggerInternalHook } from "./internal-hooks.js";

export function startAgentEventsHookBridge(opts?: {
  enabled?: boolean;
  includeSensitiveHookContext?: boolean;
  includeErrorStack?: boolean;
}) {
  if (!opts?.enabled) return null;
  const includeSensitiveHookContext = Boolean(opts.includeSensitiveHookContext);
  const includeErrorStack = Boolean(opts.includeErrorStack);
  return onAgentEvent((evt) => {
    const sessionKey = evt.sessionKey ?? "";
    const baseContext = {
      runId: evt.runId,
      seq: evt.seq,
      ts: evt.ts,
      stream: evt.stream,
    };
    if (evt.stream === "lifecycle") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      const action = phase === "error" ? "error" : phase;
      if (action !== "start" && action !== "end" && action !== "error") return;
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
      const errorMessage = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      const errorStack = typeof evt.data?.stack === "string" ? evt.data.stack : undefined;
      const dataRecord =
        evt.data && typeof evt.data === "object" ? (evt.data as Record<string, unknown>) : {};
      const dataWithoutStack = includeErrorStack
        ? dataRecord
        : Object.fromEntries(Object.entries(dataRecord).filter(([key]) => key !== "stack"));
      const hookEvent = createInternalHookEvent(
        "agent",
        action,
        sessionKey,
        buildInternalHookContext(
          includeSensitiveHookContext,
          {
            ...baseContext,
            phase,
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(endedAt !== undefined ? { endedAt } : {}),
            data: includeErrorStack ? evt.data : dataWithoutStack,
            ...(errorMessage ? { message: errorMessage } : {}),
            ...(includeErrorStack && errorStack ? { stack: errorStack } : {}),
          },
          {
            ...baseContext,
            phase,
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(endedAt !== undefined ? { endedAt } : {}),
            ...(errorMessage ? { hasErrorMessage: true } : {}),
            ...(includeErrorStack && errorStack ? { hasErrorStack: true } : {}),
          },
        ),
      );
      void triggerInternalHook(hookEvent);
      return;
    }

    if (evt.stream === "tool") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (!phase) return;
      const name = typeof evt.data?.name === "string" ? evt.data.name : undefined;
      const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : undefined;
      const hookEvent = createInternalHookEvent(
        "tool",
        phase,
        sessionKey,
        buildInternalHookContext(
          includeSensitiveHookContext,
          {
            ...baseContext,
            phase,
            ...(name ? { name } : {}),
            ...(toolCallId ? { toolCallId } : {}),
            ...(typeof evt.data?.isError === "boolean" ? { isError: evt.data.isError } : {}),
            hasArgs: evt.data?.args !== undefined,
            hasPartialResult: evt.data?.partialResult !== undefined,
            hasResult: evt.data?.result !== undefined,
            data: evt.data,
          },
          {
            ...baseContext,
            phase,
            ...(name ? { name } : {}),
            ...(toolCallId ? { toolCallId } : {}),
            ...(typeof evt.data?.isError === "boolean" ? { isError: evt.data.isError } : {}),
            hasArgs: evt.data?.args !== undefined,
            hasPartialResult: evt.data?.partialResult !== undefined,
            hasResult: evt.data?.result !== undefined,
          },
        ),
      );
      void triggerInternalHook(hookEvent);
      return;
    }

    if (evt.stream === "compaction") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (!phase) return;
      const hookEvent = createInternalHookEvent(
        "compaction",
        phase,
        sessionKey,
        buildInternalHookContext(
          includeSensitiveHookContext,
          {
            ...baseContext,
            phase,
            ...(typeof evt.data?.willRetry === "boolean" ? { willRetry: evt.data.willRetry } : {}),
            data: evt.data,
          },
          {
            ...baseContext,
            phase,
            ...(typeof evt.data?.willRetry === "boolean" ? { willRetry: evt.data.willRetry } : {}),
          },
        ),
      );
      void triggerInternalHook(hookEvent);
    }
  });
}
