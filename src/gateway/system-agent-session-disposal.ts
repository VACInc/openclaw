type DisposableSystemAgentSession = {
  engine: {
    beginDisposalForGatewayShutdown: () => Promise<void>;
    finishDisposalForGatewayShutdown: () => Promise<void>;
  };
};

type DisposableSystemAgentEngine = DisposableSystemAgentSession["engine"];

const pendingSystemAgentEngines = new WeakMap<
  Map<string, DisposableSystemAgentSession>,
  Set<DisposableSystemAgentEngine>
>();

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

/** Track an engine before its partially initialized session can enter the live session map. */
export function registerPendingGatewaySystemAgentEngine(
  sessions: Map<string, DisposableSystemAgentSession>,
  engine: DisposableSystemAgentEngine,
): () => void {
  let pending = pendingSystemAgentEngines.get(sessions);
  if (!pending) {
    pending = new Set();
    pendingSystemAgentEngines.set(sessions, pending);
  }
  pending.add(engine);
  return () => {
    pending?.delete(engine);
    if (pending?.size === 0) {
      pendingSystemAgentEngines.delete(sessions);
    }
  };
}

/** Begin draining every chat engine before the harness runtime that owns its bindings. */
export function beginGatewaySystemAgentSessionDisposal(
  sessions: Map<string, DisposableSystemAgentSession>,
): GatewaySystemAgentSessionDisposal {
  const engines = new Set(Array.from(sessions.values(), (session) => session.engine));
  for (const engine of pendingSystemAgentEngines.get(sessions) ?? []) {
    engines.add(engine);
  }
  sessions.clear();
  pendingSystemAgentEngines.delete(sessions);
  return {
    drain: settleSystemAgentDisposals(
      Array.from(engines, (engine) => engine.beginDisposalForGatewayShutdown()),
    ),
    finish: async () =>
      await settleSystemAgentDisposals(
        Array.from(engines, (engine) => engine.finishDisposalForGatewayShutdown()),
      ),
  };
}
