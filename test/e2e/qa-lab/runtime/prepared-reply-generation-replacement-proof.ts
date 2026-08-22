import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  startQaGatewayChild,
  startQaMockOpenAiServer,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  MODEL_REF as DEFAULT_MOCK_MODEL_REF,
  PROOF_TIMEOUT_MS,
  waitFor,
} from "./cloud-worker-midturn-loss-fixture.js";
import { connectWireClient } from "./paired-node-worker-wire-fixture.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "prepared-reply-generation-replacement";
const VERDICT_FILE = `${SCENARIO_ID}-verdict.json`;
const TRACE_FILE = `${SCENARIO_ID}-trace.jsonl`;
const PROVIDER_ID = "qa-embedded-generation";
const MODEL_ID = "qa-embedded-generation-model";
const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;
const SESSION_BASELINE = "agent:qa:prepared-generation-baseline";
const SESSION_TURN = "agent:qa:prepared-generation-held";

const BASELINE_REPLY = "PREPARED-GENERATION-BASELINE-OK";
const HELD_REPLY = "PREPARED-GENERATION-HELD-OK";
const PARKED_REPLY = "PREPARED-GENERATION-PARKED-OK";
/** Marks the provider request whose completion must stay held across the replacement. */
const HOLD_MARKER = "PREPARED-GENERATION-HOLD-COMPLETION";
const SOURCE_CREDENTIAL_PREFIX = "qa-embedded-source";
const MISMATCH_ERROR_TEXT = "prepared model runtime replaced the admitted plugin generation";
const RELOAD_SENTINEL = "config hot reload applied";

type CredentialGeneration = "A" | "B" | "unknown";

type ProviderRequestRecord = {
  at: number;
  generation: CredentialGeneration;
  held: boolean;
  promptHasHoldMarker: boolean;
  promptHasParkedMarker: boolean;
};

type TraceEvent = Record<string, unknown>;

type ProducerOptions = { artifactBase: string; repoRoot: string };

function parseOptions(argv: readonly string[]): ProducerOptions {
  const index = argv.indexOf("--artifact-base");
  const artifactBase = index >= 0 ? argv[index + 1] : undefined;
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(artifactBase), repoRoot: process.cwd() };
}

function classifyCredential(value: string | undefined): CredentialGeneration {
  const credential = value?.replace(/^Bearer\s+/iu, "");
  if (credential === `${SOURCE_CREDENTIAL_PREFIX}-A`) {
    return "A";
  }
  if (credential === `${SOURCE_CREDENTIAL_PREFIX}-B`) {
    return "B";
  }
  return "unknown";
}

/**
 * Auth-inspecting proxy in front of the mock OpenAI server. Records which
 * credential generation every provider request used and holds requests whose
 * body carries the hold marker until the barrier file is released.
 */
async function startHoldingAuthProxy(params: { targetBaseUrl: string; barrierPath: string }) {
  const records: ProviderRequestRecord[] = [];
  let releaseWatchers = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const body = Buffer.concat(chunks);
      const bodyText = body.toString("utf8");
      const promptHasHoldMarker = bodyText.includes(HOLD_MARKER);
      const promptHasParkedMarker = bodyText.includes(PARKED_REPLY);
      const record: ProviderRequestRecord = {
        at: Date.now(),
        generation: classifyCredential(request.headers.authorization),
        held: promptHasHoldMarker,
        promptHasHoldMarker,
        promptHasParkedMarker,
      };
      records.push(record);
      if (!promptHasHoldMarker) {
        await forwardAndReply({
          request,
          response,
          targetBaseUrl: params.targetBaseUrl,
          body,
        });
        return;
      }
      // Hold the completion so the turn occupies the main agent lane while the
      // replacement publishes; the parked turn stays queued behind it.
      for (;;) {
        const barrier = await fs.readFile(params.barrierPath, "utf8").catch(() => "");
        if (barrier.trim() === "released") {
          break;
        }
        releaseWatchers += 1;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        releaseWatchers -= 1;
      }
      await forwardAndReply({
        request,
        response,
        targetBaseUrl: params.targetBaseUrl,
        body,
      });
    })().catch((error: unknown) => {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("prepared-generation auth proxy did not bind");
  }
  return {
    records,
    get holdWaiterPolls() {
      return releaseWatchers;
    },
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function forwardAndReply(params: {
  request: import("node:http").IncomingMessage;
  response: import("node:http").ServerResponse;
  targetBaseUrl: string;
  body: Buffer;
}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(params.request.headers)) {
    if (value === undefined || ["connection", "content-length", "host"].includes(name)) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const upstream = await fetch(new URL(params.request.url ?? "/", params.targetBaseUrl), {
    method: params.request.method,
    headers,
    ...(params.body.length > 0 ? { body: new Uint8Array(params.body) } : {}),
  });
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!["connection", "content-length", "transfer-encoding"].includes(name)) {
      responseHeaders[name] = value;
    }
  });
  params.response.writeHead(upstream.status, responseHeaders);
  params.response.end(Buffer.from(await upstream.arrayBuffer()));
}

function buildProviderConfig(params: {
  generation: "A" | "B";
  mockProviderBaseUrl: string;
}): NonNullable<OpenClawConfig["models"]>["providers"] {
  return {
    [PROVIDER_ID]: {
      api: "openai-responses",
      apiKey: `${SOURCE_CREDENTIAL_PREFIX}-${params.generation}`,
      baseUrl: params.mockProviderBaseUrl,
      request: { allowPrivateNetwork: true },
      models: [
        {
          id: MODEL_ID,
          name: "QA prepared-generation model",
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_768,
          contextTokens: 32_768,
          maxTokens: 256,
        },
      ],
    },
  };
}

function buildInitialConfigPatch(mockProviderBaseUrl: string) {
  return (config: OpenClawConfig): OpenClawConfig => ({
    ...config,
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        ...buildProviderConfig({ generation: "A", mockProviderBaseUrl }),
      },
    },
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        model: { primary: MODEL_REF, fallbacks: [] },
      },
    },
    // Default "steer" would merge the parked message into the active turn; the
    // queued follow-up path only exists when the message becomes its own drained run.
    messages: { ...config.messages, queue: { ...config.messages?.queue, mode: "followup" } },
  });
}

async function appendTrace(tracePath: string, event: TraceEvent): Promise<void> {
  await fs.appendFile(tracePath, `${JSON.stringify({ at: Date.now(), ...event })}\n`, "utf8");
}

async function startTurn(
  operator: Awaited<ReturnType<typeof connectWireClient>>,
  sessionKey: string,
  message: string,
): Promise<string> {
  const runId = `${SCENARIO_ID}-${randomUUID()}`;
  const started = await operator.request<{ status?: string; runId?: string }>("chat.send", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: runId,
  });
  if (started.status !== "started" || started.runId !== runId) {
    throw new Error(`chat.send did not start turn: ${JSON.stringify(started)}`);
  }
  return started.runId!;
}

async function waitForTurn(
  operator: Awaited<ReturnType<typeof connectWireClient>>,
  runId: string,
): Promise<void> {
  // agent.wait answers a queued follow-up immediately with pending/queue instead
  // of blocking, so keep polling until the drained run reports a terminal status.
  await waitFor(`turn ${runId} completed`, async () => {
    const result = await operator.request<{ status?: string; timeoutPhase?: string }>(
      "agent.wait",
      { runId, timeoutMs: PROOF_TIMEOUT_MS },
      { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
    );
    if (result.status === "pending" && result.timeoutPhase === "queue") {
      return undefined;
    }
    if (result.status !== "ok") {
      throw new Error(`turn failed: ${JSON.stringify(result)}`);
    }
    return result;
  });
}

/**
 * Gateway-observable queue-admission barrier: chat.send acks before detached
 * dispatch, so only the gateway's own queued-run state proves the turn was
 * admitted behind the active run before the replacement published. agent.wait
 * answers immediately with status "pending" / timeoutPhase "queue" for a run
 * parked in the reply queue.
 */
async function waitForTurnQueued(
  operator: Awaited<ReturnType<typeof connectWireClient>>,
  runId: string,
): Promise<{ status?: string; timeoutPhase?: string }> {
  return await waitFor(`turn ${runId} admitted to the reply queue`, async () => {
    const wait = await operator.request<{ status?: string; timeoutPhase?: string; runId?: string }>(
      "agent.wait",
      { runId, timeoutMs: 250 },
      { timeoutMs: 10_000 },
    );
    if (wait.status === "pending" && wait.timeoutPhase === "queue") {
      return wait;
    }
    if (wait.status === "ok") {
      throw new Error("parked turn completed before the replacement was published");
    }
    return undefined;
  });
}

function historyMessageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
        )
        .join("")
    : "";
}

async function historyReplyCount(
  operator: Awaited<ReturnType<typeof connectWireClient>>,
  sessionKey: string,
  reply: string,
): Promise<number> {
  const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
    sessionKey,
    limit: 100,
  });
  return (history.messages ?? []).filter(
    (message) =>
      (message as { role?: unknown }).role === "assistant" &&
      historyMessageText(message).includes(reply),
  ).length;
}

async function waitForHistoryReply(
  operator: Awaited<ReturnType<typeof connectWireClient>>,
  sessionKey: string,
  reply: string,
): Promise<void> {
  await waitFor(`history reply ${reply}`, async () => {
    const count = await historyReplyCount(operator, sessionKey, reply);
    if (count > 1) {
      throw new Error(`history persisted ${count} copies of ${reply}`);
    }
    return count === 1 ? true : undefined;
  });
}

async function hotPublishGenerationB(params: {
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  mockProviderBaseUrl: string;
}): Promise<{ pidBefore: number | null; pidAfter: number | null }> {
  const before = (await params.gateway.call("system.info", {})) as { pid?: number };
  const config = JSON.parse(await fs.readFile(params.gateway.configPath, "utf8")) as OpenClawConfig;
  const next: OpenClawConfig = {
    ...config,
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        ...buildProviderConfig({
          generation: "B",
          mockProviderBaseUrl: params.mockProviderBaseUrl,
        }),
      },
    },
  };
  await fs.writeFile(params.gateway.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await waitFor("prepared-model runtime replacement commit sentinel", async () => {
    const logs = params.gateway.logs();
    return logs.includes(RELOAD_SENTINEL) ? logs : undefined;
  });
  const after = (await params.gateway.call("system.info", {})) as { pid?: number };
  if (!Number.isSafeInteger(before.pid) || after.pid !== before.pid) {
    throw new Error(`hot publish restarted the gateway: ${before.pid} -> ${after.pid}`);
  }
  return { pidBefore: before.pid ?? null, pidAfter: after.pid ?? null };
}

function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

async function runProof(options: ProducerOptions) {
  // openclaw-temp-dir: standalone QA producer owns and removes this fixture root.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prepared-generation-"));
  const tracePath = path.join(options.artifactBase, TRACE_FILE);
  const barrierPath = path.join(root, "provider-completion-barrier");
  const timeline: TraceEvent[] = [];
  const recordTimeline = async (event: TraceEvent) => {
    timeline.push(event);
    await appendTrace(tracePath, event);
  };
  const mock = await startQaMockOpenAiServer({ modelRefs: [MODEL_REF, DEFAULT_MOCK_MODEL_REF] });
  const proxy = await startHoldingAuthProxy({
    targetBaseUrl: mock.baseUrl,
    barrierPath,
  });
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
  let proofError: Error | undefined;
  let verdict: Record<string, unknown> | undefined;
  try {
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.rm(tracePath, { force: true });
    await fs.writeFile(barrierPath, "armed\n", "utf8");
    await recordTimeline({ event: "ephemeral-gateway-starting", scenario: SCENARIO_ID });
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${proxy.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: DEFAULT_MOCK_MODEL_REF,
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mutateConfig: buildInitialConfigPatch(`${proxy.baseUrl}/v1`),
    });
    operator = await connectWireClient({
      gateway: gateway!,
      role: "operator",
      identity: null,
    });

    await recordTimeline({ event: "ephemeral-gateway-ready", pid: gateway.pid });

    // Baseline: one full embedded turn on the admitted generation A.
    const baselineRun = await startTurn(
      operator,
      SESSION_BASELINE,
      `Reply exactly: ${BASELINE_REPLY}`,
    );
    await waitForTurn(operator, baselineRun);
    await waitForHistoryReply(operator, SESSION_BASELINE, BASELINE_REPLY);
    await recordTimeline({ event: "baseline-turn-delivered", reply: BASELINE_REPLY });

    // Held turn X occupies the main lane inside its provider call.
    const heldRun = await startTurn(
      operator,
      SESSION_TURN,
      `${HOLD_MARKER} Reply exactly: ${HELD_REPLY}`,
    );
    await waitFor("held turn provider request observed", async () => {
      const held = proxy.records.find((record) => record.promptHasHoldMarker);
      return held ? held : undefined;
    });
    await recordTimeline({ event: "held-turn-admitted-and-gated", runId: heldRun });

    // Parked turn T is admitted behind X and waits in the reply queue. The
    // queued-state barrier proves admission before anything publishes B.
    const parkedRun = await startTurn(operator, SESSION_TURN, `Reply exactly: ${PARKED_REPLY}`);
    const parkedQueuedState = await waitForTurnQueued(operator, parkedRun);
    if (proxy.records.some((record) => record.promptHasParkedMarker)) {
      throw new Error("parked turn reached the provider before the replacement committed");
    }
    await recordTimeline({
      event: "parked-turn-admitted",
      runId: parkedRun,
      queuedState: {
        status: parkedQueuedState.status,
        timeoutPhase: parkedQueuedState.timeoutPhase,
      },
      beforeNestedAcquisition: true,
    });

    // Real operator replacement path: openclaw.json publication -> gateway hot
    // reload -> refreshPreparedModelRuntimeSnapshots commits generation B.
    const replacement = await hotPublishGenerationB({
      gateway: gateway!,
      mockProviderBaseUrl: `${proxy.baseUrl}/v1`,
    });
    await recordTimeline({
      event: "runtime-replacement-committed",
      generation: "B",
      samePid: replacement.pidBefore === replacement.pidAfter,
    });

    // The parked turn is still queued: the committed replacement happened
    // between admission and the nested embedded acquisition.
    const stillParked = !proxy.records.some((record) => record.promptHasParkedMarker);
    if (!stillParked) {
      throw new Error("parked turn executed before the replacement was proven committed");
    }

    // Release X; both turns finish. The in-flight held turn keeps its admitted
    // generation A; the parked turn drains outside the predecessor scope and
    // re-admits on the generation current at drain time (B).
    await fs.writeFile(barrierPath, "released\n", "utf8");
    await recordTimeline({ event: "held-completion-released" });
    await waitForTurn(operator, heldRun);
    await waitForHistoryReply(operator, SESSION_TURN, HELD_REPLY);
    await waitForTurn(operator, parkedRun);
    await waitForHistoryReply(operator, SESSION_TURN, PARKED_REPLY);
    await recordTimeline({
      event: "post-replacement-turns-delivered",
      replies: [HELD_REPLY, PARKED_REPLY],
    });

    const mismatchInLogs = gateway!.logs().includes(MISMATCH_ERROR_TEXT);
    if (mismatchInLogs) {
      throw new Error(`gateway logged the mismatch failure: ${MISMATCH_ERROR_TEXT}`);
    }
    const generations = proxy.records.map((record) => ({
      generation: record.generation,
      held: record.held,
      parked: record.promptHasParkedMarker,
    }));
    const parkedGeneration = proxy.records.find(
      (record) => record.promptHasParkedMarker,
    )?.generation;
    if (parkedGeneration !== "B") {
      throw new Error(
        `parked turn drained on generation ${parkedGeneration} instead of the drain-time B ` +
          "(queued turns must re-admit outside the predecessor scope)",
      );
    }
    const heldGeneration = proxy.records.find((record) => record.promptHasHoldMarker)?.generation;
    if (heldGeneration !== "A") {
      throw new Error(`held turn switched to generation ${heldGeneration}`);
    }
    // A parked turn must never inherit the predecessor's replaced generation.
    if (proxy.records.some((record) => record.promptHasParkedMarker && record.generation === "A")) {
      throw new Error("parked turn executed a provider request on the predecessor generation A");
    }
    const counts = {
      [BASELINE_REPLY]: await historyReplyCount(operator, SESSION_BASELINE, BASELINE_REPLY),
      [HELD_REPLY]: await historyReplyCount(operator, SESSION_TURN, HELD_REPLY),
      [PARKED_REPLY]: await historyReplyCount(operator, SESSION_TURN, PARKED_REPLY),
    };
    verdict = {
      status: "pass",
      scenario: SCENARIO_ID,
      providerMode: "mock-openai-channel-rpc",
      admission: {
        heldTurnRunId: heldRun,
        parkedTurnRunId: parkedRun,
        parkedAdmittedBeforeReplacement: true,
      },
      generationHandoff: {
        heldTurnExecutedOnAdmittedGeneration: heldGeneration === "A",
        parkedTurnDrainedOnCurrentGeneration: parkedGeneration === "B",
        queuedPath: "followup queue drains outside the predecessor generation scope",
      },
      replacement: {
        path: "openclaw.json publish -> gateway hot reload -> refreshPreparedModelRuntimeSnapshots",
        committedGeneration: "B",
        samePid: replacement.pidBefore === replacement.pidAfter,
        pid: replacement.pidAfter,
      },
      deliveredReplies: counts,
      providerCredentialGenerations: generations,
      heldTurnExecutedOnAdmittedGeneration: heldGeneration === "A",
      parkedTurnDrainedOnCurrentGeneration: parkedGeneration === "B",
      mismatchErrorPresent: mismatchInLogs,
    };
    await fs.writeFile(
      path.join(options.artifactBase, VERDICT_FILE),
      `${JSON.stringify(verdict, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    proofError = error instanceof Error ? error : new Error(String(error));
  }

  // Always persist the redacted gateway log: a failed proof needs it most.
  if (gateway) {
    const redactedLog = redact(gateway.logs(), [
      gateway.token,
      gateway.tempRoot,
      options.repoRoot,
      root,
    ]);
    await fs.writeFile(
      path.join(options.artifactBase, `${SCENARIO_ID}-gateway.log`),
      `${redactedLog}\n`,
      "utf8",
    );
    const logExcerpt = redactedLog
      .split(/\r?\n/u)
      .filter((line) =>
        [RELOAD_SENTINEL, "prepared model runtime", "chat.send", "agent", MISMATCH_ERROR_TEXT].some(
          (needle) => line.toLowerCase().includes(needle.toLowerCase()),
        ),
      )
      .slice(-40)
      .join("\n");
    await fs.writeFile(
      path.join(options.artifactBase, `${SCENARIO_ID}-gateway-log-excerpt.log`),
      `${logExcerpt}\n`,
      "utf8",
    );
  }

  const cleanup = await Promise.allSettled([
    operator?.stopAndWait({ timeoutMs: 1_000 }) ?? Promise.resolve(),
    gateway?.stop() ?? Promise.resolve(),
    proxy.stop(),
    mock.stop(),
    fs.rm(root, { recursive: true, force: true }),
  ]);
  const cleanupFailures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cleanupFailures.length > 0) {
    proofError = new AggregateError(
      proofError ? [proofError, ...cleanupFailures] : cleanupFailures,
      "prepared-generation proof cleanup failed",
      proofError ? { cause: proofError } : undefined,
    );
  }
  if (proofError) {
    throw proofError;
  }
  if (!verdict) {
    throw new Error("prepared-generation proof produced no verdict");
  }
  return verdict;
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL_REF,
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Prepared reply generation replacement",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        "src/auto-reply/reply/get-reply-run.ts",
        "src/agents/embedded-agent-runner/run-orchestrator.ts",
        "src/agents/prepared-model-runtime-generation-scope.ts",
        "test/e2e/qa-lab/runtime/prepared-reply-generation-replacement-proof.ts",
      ],
    },
  });
  const startedAt = Date.now();
  try {
    const verdict = await runProof(options);
    writer.appendLog(`pass: ${JSON.stringify(verdict)}\n`);
    return await writer.write({
      artifacts: [
        { filePath: VERDICT_FILE, kind: "verdict" },
        { filePath: TRACE_FILE, kind: "trace" },
        { filePath: `${SCENARIO_ID}-gateway-log-excerpt.log`, kind: "trace" },
      ],
      details:
        "An ephemeral gateway with a mocked OpenAI transport held one admitted turn through a real config-reload plugin-runtime replacement, proved the second turn was parked in the reply queue via the gateway's queued-run state before publication, and delivered the in-flight reply on its admitted generation while the queued turn re-admitted on the replacement generation at drain time",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const evidence = await runProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Prepared-generation evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Prepared-generation verdict: ${path.join(options.artifactBase, VERDICT_FILE)}`);
  if (status === "pass") {
    console.log((await fs.readFile(path.join(options.artifactBase, VERDICT_FILE), "utf8")).trim());
  }
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
