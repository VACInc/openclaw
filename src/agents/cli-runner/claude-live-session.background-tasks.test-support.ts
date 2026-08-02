import { vi } from "vitest";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { supervisorSpawnMock } from "../cli-runner.test-support.js";
import { runClaudeLiveSessionTurn } from "./claude-live-session.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

function buildPreparedCliRunContext(params: {
  runId: string;
  timeoutMs?: number;
  sessionId?: string;
  sessionKey?: string;
  credentialFingerprint?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    output: "jsonl" as const,
    input: "stdin" as const,
    modelArg: "--model",
    sessionArgs: ["--session-id", "{sessionId}"],
    sessionMode: "always" as const,
    systemPromptFileArg: "--append-system-prompt-file",
    systemPromptWhen: "first" as const,
    serialize: true,
    liveSession: "claude-stdio" as const,
  };
  return {
    params: {
      sessionId: params.sessionId ?? "s-bg",
      sessionKey: params.sessionKey ?? "agent:main:bg",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: params.timeoutMs ?? 60_000,
      runId: params.runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: true,
      pluginId: "anthropic",
    },
    preparedBackend: {
      backend,
      env: {},
      ...(params.credentialFingerprint
        ? {
            secretInput: {
              fd: 3,
              fingerprint: params.credentialFingerprint,
              createData: () => Buffer.from("secret"),
            },
          }
        : {}),
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "sonnet",
    normalizedModel: "sonnet",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function getProcessSupervisorForTest() {
  return {
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  };
}

export function installLiveStdoutDriver(params?: {
  onWrite?: (stdout: (chunk: string) => void, input: string) => void;
}): {
  cancel: ReturnType<typeof vi.fn>;
  stdout: { emit: (chunk: string) => void; waitReady: () => Promise<void> };
} {
  let stdoutListener: ((chunk: string) => void) | undefined;
  const cancel = vi.fn();
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const stdin = {
    write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      if (stdoutListener && params?.onWrite) {
        params.onWrite(stdoutListener, data);
      }
      cb?.();
      markReady?.();
    }),
    end: vi.fn(),
  };
  supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
    const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
    stdoutListener = input.onStdout;
    return {
      runId: "live-bg-run",
      pid: 4242,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel,
    };
  });
  return {
    cancel,
    stdout: {
      emit: (chunk: string) => {
        stdoutListener?.(chunk);
      },
      waitReady: () => ready,
    },
  };
}

export function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export function startLiveTurn(params: {
  runId: string;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  useResume?: boolean;
  onPhase?: (phase: "send" | "resolve") => void;
  credentialFingerprint?: string;
}) {
  const context = buildPreparedCliRunContext({
    runId: params.runId,
    timeoutMs: params.timeoutMs,
    credentialFingerprint: params.credentialFingerprint,
  });
  return runClaudeLiveSessionTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume: params.useResume ?? false,
    noOutputTimeoutMs: params.noOutputTimeoutMs ?? 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    onPhase: params.onPhase,
    cleanup: async () => {},
  });
}
