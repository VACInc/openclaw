import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  RuntimeSystemAgentChatEngine,
  SystemAgentInferenceUnavailableError,
  type OpenClawConfig,
  type SystemAgentChatEngineOptions,
} from "./chat-engine.test-support.js";

const abortTestConfig = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

describe("SystemAgentChatEngine facade", () => {
  it("cancels and drains an accepted turn before disposal", async () => {
    const config = abortTestConfig;
    const verifiedInference = await createAmbientVerifiedBinding(config);
    let observedAbort = false;
    let releaseAbort: () => void = () => {};
    const runAgentTurn = vi.fn(
      async ({
        abortSignal,
      }: Parameters<NonNullable<SystemAgentChatEngineOptions["runAgentTurn"]>>[0]) => {
        if (!abortSignal) {
          throw new Error("missing test abort signal");
        }
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            observedAbort = true;
            releaseAbort = resolve;
          };
          if (abortSignal.aborted) {
            onAbort();
          } else {
            abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        });
        abortSignal.throwIfAborted();
        return null;
      },
    );
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn,
      planWithAssistant: async () => null,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });
    const wizard = (
      engine as unknown as {
        wizard: { cancel: (cancel: { stepId: string }) => Promise<unknown>; dispose: () => void };
      }
    ).wizard;
    const wizardDispose = vi.spyOn(wizard, "dispose");
    const wizardCancel = vi.spyOn(wizard, "cancel");
    const activeTurn = engine.handle("keep working");
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledOnce());
    const queuedCancel = engine.cancelWizard({ stepId: "queued-step" });

    let disposed = false;
    const disposal = engine.dispose().then(() => {
      disposed = true;
    });
    await expect(engine.handle("late work")).rejects.toThrow("chat engine is disposed");
    await vi.waitFor(() => expect(observedAbort).toBe(true));
    expect(disposed).toBe(false);
    expect(wizardDispose).not.toHaveBeenCalled();

    releaseAbort();
    await expect(activeTurn).rejects.toThrow("agent run aborted");
    await expect(queuedCancel).rejects.toThrow("agent run aborted");
    await disposal;
    expect(disposed).toBe(true);
    expect(wizardDispose).toHaveBeenCalledOnce();
    expect(wizardCancel).not.toHaveBeenCalled();
  });

  it("does not finalize cleanup while a runner still ignores abort", async () => {
    const config = abortTestConfig;
    const verifiedInference = await createAmbientVerifiedBinding(config);
    const neverSettles = new Promise<null>(() => {});
    const runAgentTurn = vi.fn(async () => await neverSettles);
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });
    const wizard = (
      engine as unknown as {
        wizard: { dispose: () => void };
      }
    ).wizard;
    const wizardDispose = vi.spyOn(wizard, "dispose");
    void engine.handle("keep working");
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledOnce());

    void engine.beginDisposalForGatewayShutdown();
    void engine.finishDisposalForGatewayShutdown();
    await Promise.resolve();

    expect(wizardDispose).not.toHaveBeenCalled();
  });

  it("cancels planner fallback without executing its late command", async () => {
    const config = abortTestConfig;
    const verifiedInference = await createAmbientVerifiedBinding(config);
    const runConfigSet = vi.fn(async () => {});
    let plannerSignal: AbortSignal | undefined;
    let releasePlanner: () => void = () => {};
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const planner: NonNullable<SystemAgentChatEngineOptions["planWithAssistant"]> = async (
      params,
    ) => {
      plannerSignal = params.abortSignal;
      await plannerGate;
      return { reply: "Applying.", command: "config set gateway.port 19001" };
    };
    const engine = new SystemAgentChatEngine({
      yes: true,
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
        runConfigSet,
      },
    });
    const activeTurn = engine.handle("please adjust the gateway");
    await vi.waitFor(() => expect(plannerSignal).toBeDefined());

    const disposal = engine.dispose();
    expect(plannerSignal?.aborted).toBe(true);
    releasePlanner();

    await expect(activeTurn).rejects.toThrow("agent run aborted");
    await disposal;
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("rejects a late approved directive after disposal", async () => {
    const config = abortTestConfig;
    const verifiedInference = await createAmbientVerifiedBinding(config);
    const runConfigSet = vi.fn(async () => {});
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const runAgentTurn = vi.fn<NonNullable<SystemAgentChatEngineOptions["runAgentTurn"]>>(
      async () => {
        await turnGate;
        return {
          text: "Applying.",
          directive: {
            kind: "approved-operation",
            operation: { kind: "config-set", path: "gateway.port", value: "19001" },
          },
        };
      },
    );
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
        runConfigSet,
      },
    });
    const activeTurn = engine.handle("apply the change");
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledOnce());

    const disposal = engine.dispose();
    releaseTurn();

    await expect(activeTurn).rejects.toThrow("agent run aborted");
    await disposal;
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("rejects a directive aborted during its final verification", async () => {
    const config = abortTestConfig;
    const verifiedInference = await createAmbientVerifiedBinding(config);
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => ({
        text: "Connecting.",
        directive: { kind: "channel-setup", channel: "telegram" },
      }),
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });
    const router = (
      engine as unknown as {
        router: {
          callbacks: { requireVerifiedInference: () => Promise<unknown> };
        };
        wizard: { startChannel: (channel: string) => Promise<unknown> };
      }
    ).router;
    const wizard = (
      engine as unknown as {
        wizard: { startChannel: (channel: string) => Promise<unknown> };
      }
    ).wizard;
    const startChannel = vi.spyOn(wizard, "startChannel");
    const originalVerification = router.callbacks.requireVerifiedInference;
    let releaseFinalVerification: () => void = () => {};
    const finalVerification = new Promise<void>((resolve) => {
      releaseFinalVerification = resolve;
    });
    const requireVerifiedInference = vi
      .fn(originalVerification)
      .mockImplementationOnce(originalVerification)
      .mockImplementationOnce(async () => await finalVerification);
    router.callbacks.requireVerifiedInference = requireVerifiedInference;
    const activeTurn = engine.handle("please help with the channel");
    await vi.waitFor(() => expect(requireVerifiedInference).toHaveBeenCalledTimes(2));

    const disposal = engine.dispose();
    releaseFinalVerification();

    await expect(activeTurn).rejects.toThrow("agent run aborted");
    await disposal;
    expect(startChannel).not.toHaveBeenCalled();
  });

  it("rejects an approved operation aborted at its commit edge", async () => {
    const config = abortTestConfig;
    const verifiedInference = await createAmbientVerifiedBinding(config);
    const committed = vi.fn();
    let markOperationStarted: () => void = () => {};
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });
    const executeOperation = vi.fn(async (_operation, _runtime, options) => {
      markOperationStarted();
      await options.beforePersistentApply?.();
      committed();
      return { applied: true };
    });
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      executeOperation: executeOperation as never,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });
    const router = (
      engine as unknown as {
        router: {
          applyApprovedPersistentOperation: (operation: {
            kind: "config-set";
            path: string;
            value: string;
          }) => Promise<unknown>;
          callbacks: {
            requirePersistentApplyInference: () => Promise<unknown>;
          };
        };
      }
    ).router;
    let releaseCommitEdge: () => void = () => {};
    const commitEdge = new Promise<void>((resolve) => {
      releaseCommitEdge = resolve;
    });
    router.callbacks.requirePersistentApplyInference = async () => await commitEdge;
    const operation = router.applyApprovedPersistentOperation({
      kind: "config-set",
      path: "gateway.port",
      value: "19001",
    });
    await Promise.race([
      operationStarted,
      operation.then(
        () => {
          throw new Error("operation completed before its commit edge");
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    expect(executeOperation).toHaveBeenCalledOnce();

    const disposal = engine.dispose();
    releaseCommitEdge();

    await expect(operation).rejects.toThrow("agent run aborted");
    await disposal;
    expect(committed).not.toHaveBeenCalled();
  });

  it("classifies a null planner result as cancellation after disposal", async () => {
    const config = abortTestConfig;
    const verifiedInference = await createAmbientVerifiedBinding(config);
    let releasePlanner: () => void = () => {};
    const plannerGate = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const planner = vi.fn(async () => {
      await plannerGate;
      return null;
    });
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });
    const activeTurn = engine.handle("please inspect this");
    await vi.waitFor(() => expect(planner).toHaveBeenCalledOnce());

    const disposal = engine.dispose();
    releasePlanner();

    await expect(activeTurn).rejects.toThrow("agent run aborted");
    await disposal;
  });

  it("rejects a seeded approval when its binding changes during classification", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = baseConfig as OpenClawConfig;
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      classifyApproval: async () => {
        currentConfig = changedConfig;
        return "approve";
      },
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        runConfigSet,
      },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await expect(engine.handle("yes")).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("rejects a setup write without a verified inference binding", async () => {
    useTempStateDir();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: null,
      configHashAfter: "after",
      bootstrapPending: false,
      workspaceReady: true,
      gateway: { status: "ready" as const, action: "reused" as const },
      lines: ["Workspace: /tmp/work"],
    }));
    expect(
      () =>
        new RuntimeSystemAgentChatEngine({
          surface: "cli",
          runAgentTurn: async () => null,
          planWithAssistant: async () => null,
          deps: {
            applySetup,
            loadOverview: fakeOverviewLoader(),
          },
        } as unknown as SystemAgentChatEngineOptions),
    ).toThrow(SystemAgentInferenceUnavailableError);
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("does not expose a custom planner reply after its inference owner drifts", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig: OpenClawConfig = baseConfig;
    const planner = vi.fn(async () => {
      currentConfig = changedConfig;
      return { reply: "stale reply" };
    });
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });

    await expect(engine.handle("what should I do next?")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
  });

  it("fails closed when neither inference path is usable", async () => {
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => {
        throw new Error("workspace owner openclaw is missing from the roster");
      },
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await expect(engine.handle("please make everything nice")).rejects.toThrow(
      "workspace owner openclaw is missing from the roster",
    );
  });
});
