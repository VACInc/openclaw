// OpenClaw chat engine: stable transport-agnostic facade over turn and wizard owners.
import type {
  SystemAgentWizardCancel,
  WizardAnswer,
} from "../../packages/gateway-protocol/src/index.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  cleanupSystemAgentSession,
  createSystemAgentSession,
  type SystemAgentSession,
  type SystemAgentTurnRunner,
} from "./agent-turn.js";
import type { SystemAgentApprovalClassifier } from "./approval-intent.js";
import type { SystemAgentAssistantPlanner, SystemAgentAssistantTurn } from "./assistant.js";
import {
  ChatTurnRouter,
  redactSensitiveCommandText,
  type SystemAgentChatTurnOptions,
} from "./chat-turn-router.js";
import {
  ChatWizardHost,
  type ChatWizardHostDependencies,
  type SystemAgentChatReply,
} from "./chat-wizard-host.js";
import type {
  SystemAgentGreetingFacts,
  SystemAgentGreetingPlan,
  SystemAgentGreetingPlanner,
} from "./greeting.js";
import {
  SystemAgentInferenceUnavailableError,
  isSystemAgentInferenceUnavailableError,
} from "./inference-error.js";
import type { SystemAgentCommandDeps, SystemAgentOperation } from "./operations.js";
import { loadSystemAgentOverview, type SystemAgentOverview } from "./overview.js";
import { verifyConfigAfterSystemAgentWrite } from "./post-write-verification.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";

export { SystemAgentWizardAnswerError } from "./chat-wizard-host.js";

export type SystemAgentChatEngineOptions = {
  yes?: boolean;
  deps?: SystemAgentCommandDeps;
  planWithAssistant?: SystemAgentAssistantPlanner;
  planGreeting?: SystemAgentGreetingPlanner;
  runAgentTurn?: SystemAgentTurnRunner;
  classifyApproval?: SystemAgentApprovalClassifier;
  surface?: "cli" | "gateway";
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  operatorApprovalOnly?: boolean;
  /** Host-recorded origin for delegated create-agent proposals. */
  requesterAgentId?: string;
};

type SystemAgentChatEngineInternals = {
  wizardDependencies?: ChatWizardHostDependencies;
  executeOperation?: typeof import("./operations.js").executeSystemAgentOperation;
};

/**
 * One conversation with OpenClaw, independent of transport. The facade owns
 * serialization, history, and the verified inference session; concept owners
 * route turns and host setup wizards behind the stable public entrypoint.
 */
export class SystemAgentChatEngine {
  private readonly history: SystemAgentAssistantTurn[] = [];
  private readonly agentSession: SystemAgentSession;
  private readonly wizard: ChatWizardHost;
  private readonly router: ChatTurnRouter;
  private verifiedInference: SystemAgentVerifiedInferenceBinding;
  private turnQueue: Promise<unknown> = Promise.resolve();
  private turnDrain: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;
  private sessionCleanup: Promise<void> | undefined;
  private disposed = false;
  private readonly turnAbort = new AbortController();

  constructor(
    private readonly options: SystemAgentChatEngineOptions,
    internals: SystemAgentChatEngineInternals = {},
  ) {
    const binding = options?.verifiedInference;
    if (!binding) {
      throw new SystemAgentInferenceUnavailableError("conversation");
    }
    this.verifiedInference = binding;
    this.agentSession = createSystemAgentSession(binding);
    this.wizard = new ChatWizardHost({
      surface: options.surface,
      beforePersistentApply: async (runtime) => {
        await this.requirePersistentApplyInference(runtime);
        this.turnAbort.signal.throwIfAborted();
      },
      dependencies: internals.wizardDependencies,
    });
    this.router = new ChatTurnRouter(
      { ...options, abortSignal: this.turnAbort.signal },
      { executeOperation: internals.executeOperation },
      this.agentSession,
      this.wizard,
      {
        requireVerifiedInference: async () => await this.requireVerifiedInference(),
        requirePersistentApplyInference: async (runtime) =>
          await this.requirePersistentApplyInference(runtime),
        rebindVerifiedInference: (next) => this.rebindVerifiedInference(next),
        getVerifiedInference: () => this.verifiedInference,
        loadOverview: async () => await this.loadOverview(),
        getHistory: () => this.history,
        verifyConfigAfterWrite: async () => await this.verifyConfigAfterWrite(),
      },
    );
  }

  propose(operation: SystemAgentOperation): string {
    return this.router.propose(operation);
  }

  getPendingOperatorProposal(): { operation: SystemAgentOperation; hash: string } | null {
    return this.router.getPendingOperatorProposal();
  }

  async resolveOperatorApproval(
    decision: "allow-once" | "allow-always" | "deny" | null,
    proposalHash: string,
  ): Promise<SystemAgentChatReply | null> {
    return await this.enqueueTurn(async () => {
      const reply = await this.router.resolveOperatorApproval(decision, proposalHash);
      if (reply?.text) {
        this.history.push({ role: "assistant", text: reply.text });
      }
      return reply;
    });
  }

  noteAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", text });
  }

  seedHistory(turns: readonly SystemAgentAssistantTurn[]): void {
    this.history.push(
      ...turns.map((turn) => ({
        ...turn,
        text: turn.role === "user" ? redactSensitiveCommandText(turn.text) : turn.text,
      })),
    );
  }

  historyLength(): number {
    return this.history.length;
  }

  historySince(index: number): SystemAgentAssistantTurn[] {
    return this.history.slice(index).map((turn) => ({ role: turn.role, text: turn.text }));
  }

  async dispose(): Promise<void> {
    this.disposal ??= this.beginDisposal().then(async () => await this.finalizeDisposal());
    await this.disposal;
  }

  /** Abort accepted work without starting binding cleanup during Gateway harness teardown. */
  beginDisposalForGatewayShutdown(): Promise<void> {
    return this.beginDisposal();
  }

  /** Finish binding cleanup at the shutdown phase selected by the Gateway owner. */
  async finishDisposalForGatewayShutdown(): Promise<void> {
    // Never let binding cleanup overtake work that ignored cancellation. The
    // Gateway bounds this drain and skips finalization when it does not settle.
    await this.beginDisposal();
    await this.finalizeDisposal();
  }

  /**
   * Project the live hosted-wizard interaction onto a rejoin reply so a
   * reconnecting client re-renders the answer controls this session still
   * awaits; a no-op when no wizard is active.
   */
  decorateRejoinReply(reply: SystemAgentChatReply): SystemAgentChatReply {
    return this.wizard.decorateReply(reply);
  }

  async handle(text: string, options?: SystemAgentChatTurnOptions): Promise<SystemAgentChatReply> {
    return await this.enqueueTurn(async () => {
      await this.requireVerifiedInference();
      const sensitiveTurn = this.wizard.sensitiveInputPending;
      const reply = await this.router.resolveTurn(text, options);
      return this.completeTurn(
        reply,
        sensitiveTurn ? "<redacted secret>" : redactSensitiveCommandText(text),
      );
    });
  }

  async answerWizard(answer: WizardAnswer): Promise<SystemAgentChatReply> {
    return await this.enqueueTurn(async () => {
      await this.requireVerifiedInference();
      const result = await this.router.answerWizard(this.wizard.answer(answer));
      return this.completeTurn({ text: result.text, action: "none" }, result.userHistoryText);
    });
  }

  async cancelWizard(cancel: SystemAgentWizardCancel): Promise<SystemAgentChatReply> {
    return await this.enqueueTurn(async () => {
      const result = await this.router.answerWizard(this.wizard.cancel(cancel));
      return this.completeTurn({ text: result.text, action: "none" }, result.userHistoryText);
    });
  }

  private async enqueueTurn<T>(run: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      throw new Error("System-agent chat engine is disposed");
    }
    const turn = this.turnQueue.then(async () => {
      this.turnAbort.signal.throwIfAborted();
      const result = await run();
      this.turnAbort.signal.throwIfAborted();
      return result;
    });
    this.turnQueue = turn.catch(() => undefined);
    return await turn;
  }

  private beginDisposal(): Promise<void> {
    if (!this.turnDrain) {
      this.disposed = true;
      this.turnAbort.abort(createAgentRunDirectAbortError());
      this.turnDrain = this.turnQueue.then(() => undefined);
    }
    return this.turnDrain;
  }

  private async finalizeDisposal(): Promise<void> {
    this.sessionCleanup ??= (async () => {
      this.wizard.dispose();
      await cleanupSystemAgentSession(this.agentSession);
    })();
    await this.sessionCleanup;
  }

  private completeTurn(reply: SystemAgentChatReply, userHistoryText: string): SystemAgentChatReply {
    const completed = this.wizard.decorateReply(reply);
    this.history.push({ role: "user", text: userHistoryText });
    if (completed.text) {
      this.history.push({ role: "assistant", text: completed.text });
    }
    return completed;
  }

  async loadOverview(): Promise<SystemAgentOverview> {
    const route = await this.requireVerifiedInference();
    const overview = this.options.deps?.loadOverview
      ? await this.options.deps.loadOverview()
      : await loadSystemAgentOverview();
    return { ...overview, defaultModel: route.modelLabel };
  }

  async planGreeting(params: {
    overview: SystemAgentOverview;
    facts: SystemAgentGreetingFacts;
    timeoutMs: number;
  }): Promise<SystemAgentGreetingPlan | null> {
    const planner = this.options.planGreeting;
    const plan = planner
      ? await planner(params)
      : await import("./assistant.js").then(({ planSystemAgentGreetingWithConfiguredModel }) =>
          planSystemAgentGreetingWithConfiguredModel({
            ...params,
            verifiedInference: this.verifiedInference,
            deps: this.options.deps,
          }),
        );
    if (plan) {
      await this.requireVerifiedInference();
    }
    return plan;
  }

  private async requireVerifiedInference() {
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    try {
      const route = await resolveSystemAgentVerifiedInferenceRoute(binding, this.options.deps);
      if (route) {
        return route;
      }
    } catch (error) {
      return this.throwInferenceUnavailable([error]);
    }
    return this.throwInferenceUnavailable();
  }

  private async requirePersistentApplyInference(runtime: RuntimeEnv) {
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    try {
      const { resolvePersistentApplyInference } = await import("./setup-inference.js");
      const route = await resolvePersistentApplyInference({
        binding,
        runtime,
        deps: this.options.deps,
      });
      if (route) {
        return route;
      }
    } catch (error) {
      if (isSystemAgentInferenceUnavailableError(error)) {
        return this.throwInferenceUnavailable(error.failures, false);
      }
      return this.throwInferenceUnavailable([error], false);
    }
    return this.throwInferenceUnavailable([], false);
  }

  private rebindVerifiedInference(binding: SystemAgentVerifiedInferenceBinding): void {
    if (binding.execution.agentId !== this.verifiedInference.execution.agentId) {
      return;
    }
    delete this.agentSession.cliSession;
    this.verifiedInference = binding;
    this.agentSession.verifiedInference = binding;
  }

  private throwInferenceUnavailable(failures: readonly unknown[] = [], cancelWizard = true): never {
    this.router.clearForInferenceLoss();
    delete this.agentSession.cliSession;
    if (cancelWizard) {
      this.wizard.dispose();
    }
    this.history.splice(0);
    throw new SystemAgentInferenceUnavailableError("conversation", failures);
  }

  private async verifyConfigAfterWrite(): Promise<string | null> {
    return await verifyConfigAfterSystemAgentWrite((message) =>
      this.router.resolveAssistantTurn(message, false),
    );
  }
}
