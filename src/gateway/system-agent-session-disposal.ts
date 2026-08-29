type DisposableSystemAgentSession = {
  engine: {
    beginDisposalForGatewayShutdown: () => Promise<void>;
    finishDisposalForGatewayShutdown: () => Promise<void>;
  };
};

export type GatewaySystemAgentSessionDisposal = {
  drain: Promise<void>;
  finish: () => Promise<void>;
};

async function settleSystemAgentDisposals(disposals: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(disposals);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "System-agent session disposal failed");
  }
}

/** Begin draining every chat engine before the harness runtime that owns its bindings. */
export function beginGatewaySystemAgentSessionDisposal(
  sessions: Map<string, DisposableSystemAgentSession>,
): GatewaySystemAgentSessionDisposal {
  const engines = Array.from(sessions.values(), (session) => session.engine);
  sessions.clear();
  return {
    drain: settleSystemAgentDisposals(
      engines.map((engine) => engine.beginDisposalForGatewayShutdown()),
    ),
    finish: async () =>
      await settleSystemAgentDisposals(
        engines.map((engine) => engine.finishDisposalForGatewayShutdown()),
      ),
  };
}
