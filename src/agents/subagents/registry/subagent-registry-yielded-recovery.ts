import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { resolveFinalizedSubagentTaskState } from "./subagent-registry-completion.js";
import { resolveSubagentTaskForRun } from "./subagent-registry-sweep-kill.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

export function resumeYieldedRecovery(
  runId: string,
  entry: SubagentRunRecord,
  now: number,
  params: {
    resumedRuns: Set<string>;
    getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
    startSubagentAnnounceCleanupFlow: (runId: string, entry: SubagentRunRecord) => boolean;
    resumeRequesterSettleWake: (runId: string, entry: SubagentRunRecord) => void;
  },
): boolean {
  const wake = entry.requesterSettleWake;
  if (wake?.requesterYieldBatch !== true) {
    params.resumeRequesterSettleWake(runId, entry);
    return true;
  }
  if (
    !hasSubagentRunEnded(entry) ||
    entry.terminalOwner === "interrupted-recovery" ||
    entry.execution.restartRecovery?.phase === "accepted" ||
    entry.killIntent ||
    entry.killReconciliation
  ) {
    return false;
  }

  const delivery = entry.delivery;
  const markedFinalAwaitingCleanup =
    delivery?.status === "delivered" &&
    typeof wake.rearmGeneration === "number" &&
    delivery.requesterVisibleFinalGeneration === wake.rearmGeneration;
  if (
    typeof entry.cleanupCompletedAt === "number" ||
    (delivery?.status !== "pending" &&
      delivery?.status !== "in_progress" &&
      delivery?.status !== "failed" &&
      !markedFinalAwaitingCleanup)
  ) {
    params.resumeRequesterSettleWake(runId, entry);
    return true;
  }

  const alreadyAnnounced =
    delivery?.status === "delivered" || typeof delivery?.announcedAt === "number";
  const suppressedKilledCompletion =
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.suppressCompletionDelivery === true &&
    entry.execution.outcome?.status === "error";
  if (
    entry.cleanupHandled === true ||
    (entry.completion?.resultText === undefined && !suppressedKilledCompletion) ||
    entry.endedReason === undefined ||
    entry.pauseReason === "sessions_yield" ||
    getAgentRunContext(runId) ||
    delivery?.disposition === "session_queued" ||
    (!alreadyAnnounced && !suppressedKilledCompletion && (delivery?.nextAttemptAt ?? 0) > now)
  ) {
    return true;
  }

  const expectedTask = resolveFinalizedSubagentTaskState(entry);
  const task = resolveSubagentTaskForRun(
    params.getRunsForChildSession(entry.childSessionKey),
    entry,
  );
  const committedCompletion =
    expectedTask !== undefined &&
    task.lookup === "available" &&
    task.task !== undefined &&
    (task.task.status === expectedTask.status ||
      (expectedTask.status !== "cancelled" && task.task.status === "succeeded")) &&
    task.task.endedAt === expectedTask.endedAt;
  const committedSuppressedKill =
    suppressedKilledCompletion &&
    task.lookup === "available" &&
    task.task?.status === "cancelled" &&
    typeof task.task.endedAt === "number" &&
    Number.isFinite(task.task.endedAt) &&
    typeof entry.execution.endedAt === "number" &&
    Number.isFinite(entry.execution.endedAt) &&
    task.task.endedAt >= entry.execution.endedAt;

  if (
    (committedCompletion || committedSuppressedKill) &&
    params.startSubagentAnnounceCleanupFlow(runId, entry)
  ) {
    // Exact task ownership fences provider races; delivered finals skip
    // announcement, while reconciled kills need no captured reply.
    params.resumedRuns.add(runId);
  }
  return true;
}
