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

describe("SystemAgentChatEngine facade", () => {
  it("drains an accepted turn and rejects new work before disposal", async () => {
    const config = {
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
    const verifiedInference = await createAmbientVerifiedBinding(config);
    let finishTurn: (reply: { text: string }) => void = () => {};
    const turnResult = new Promise<{ text: string }>((resolve) => {
      finishTurn = resolve;
    });
    const runAgentTurn = vi.fn(async () => await turnResult);
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn,
      planWithAssistant: async () => null,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });
    const wizardDispose = vi.spyOn(
      (engine as unknown as { wizard: { dispose: () => void } }).wizard,
      "dispose",
    );
    const activeTurn = engine.handle("keep working");
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledOnce());

    let disposed = false;
    const disposal = engine.dispose().then(() => {
      disposed = true;
    });
    await expect(engine.handle("late work")).rejects.toThrow("chat engine is disposed");
    expect(disposed).toBe(false);
    expect(wizardDispose).not.toHaveBeenCalled();

    finishTurn({ text: "done" });
    await expect(activeTurn).resolves.toMatchObject({ text: "done" });
    await disposal;
    expect(disposed).toBe(true);
    expect(wizardDispose).toHaveBeenCalledOnce();
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
