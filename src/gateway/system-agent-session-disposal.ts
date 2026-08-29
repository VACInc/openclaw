type DisposableSystemAgentSession = {
  engine: { dispose: () => Promise<void> };
};

/** Drain every chat engine before the harness runtime that owns its native bindings. */
export async function disposeGatewaySystemAgentSessions(
  sessions: Map<string, DisposableSystemAgentSession>,
): Promise<void> {
  const engines = Array.from(sessions.values(), (session) => session.engine);
  sessions.clear();
  const results = await Promise.allSettled(engines.map((engine) => engine.dispose()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "System-agent session disposal failed");
  }
}
