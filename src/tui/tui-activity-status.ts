import type { Terminal } from "@earendil-works/pi-tui";

const TUI_BUSY_ACTIVITY_STATUSES = new Set([
  "sending",
  "waiting",
  "streaming",
  "running",
  "finishing context",
  "starting up",
]);

export function isTuiBusyActivityStatus(status: string): boolean {
  return TUI_BUSY_ACTIVITY_STATUSES.has(status);
}

/**
 * Maps the TUI run lifecycle onto the Program Status Protocol (OSC 7501).
 * pi-tui owns the wire format, terminal support detection, and clearing the
 * record on stop; this module only decides which state the TUI is in.
 */
export type TuiProgramState = "idle" | "working" | "done" | "error";

const PROGRAM_STATUS_APP = "openclaw";

export function resolveTuiProgramState(params: {
  activityStatus: string;
  previous: TuiProgramState | null;
  isConnected: boolean;
}): TuiProgramState | null {
  const { activityStatus, previous, isConnected } = params;
  if (activityStatus === "starting up") {
    // Connection bootstrap, not agent work.
    return null;
  }
  if (isTuiBusyActivityStatus(activityStatus)) {
    return "working";
  }
  if (activityStatus === "error" || activityStatus === "abort failed") {
    return "error";
  }
  if (activityStatus === "aborted") {
    return "idle";
  }
  if (activityStatus === "idle") {
    if (previous === "working") {
      // A lost transport proves nothing about the run outcome.
      return isConnected ? "done" : "idle";
    }
    // Repeated idle updates must not erase an unseen result.
    return previous === "done" || previous === "error" ? null : "idle";
  }
  if (!isConnected && previous === "working") {
    return "idle";
  }
  // Display-only statuses (tool toggles, disconnect remediation text) keep the record.
  return null;
}

export function createTuiProgramStatusReporter(terminal: Pick<Terminal, "setProgramStatus">) {
  let current: TuiProgramState | null = null;
  return {
    update(params: { activityStatus: string; isConnected: boolean }) {
      const next = resolveTuiProgramState({
        activityStatus: params.activityStatus,
        isConnected: params.isConnected,
        previous: current,
      });
      if (!next || next === current) {
        return;
      }
      current = next;
      try {
        terminal.setProgramStatus({ state: next, app: PROGRAM_STATUS_APP });
      } catch {
        // Status reports are advisory; a closed terminal must not break the TUI.
      }
    },
  };
}
