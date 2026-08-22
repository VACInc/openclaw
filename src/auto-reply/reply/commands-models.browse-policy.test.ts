// Guards that /models browse builds the visibility policy once per invocation.
// Each build reloads plugin manifest metadata, which rescans every installed plugin.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { buildModelsProviderData } from "./commands-models.js";

const catalogMocks = vi.hoisted(() => ({ loadModelCatalog: vi.fn() }));
const createVisibilityPolicy = vi.hoisted(() => vi.fn());

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: catalogMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await catalogMocks.loadModelCatalog(...args);
    return { entries, routeVariants: entries };
  },
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: () =>
    Object.assign(() => true, {
      evaluateModelAuth: async () => ({ availability: true, routeResolution: null }),
    }),
  hasAuthForModelProvider: () => true,
  getCurrentProviderAuthState: () => null,
  clearCurrentProviderAuthState: () => undefined,
}));

vi.mock("../../agents/model-visibility-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-visibility-policy.js")>();
  return {
    ...actual,
    createModelVisibilityPolicy: (
      params: Parameters<typeof actual.createModelVisibilityPolicy>[0],
    ) => {
      createVisibilityPolicy(params);
      return actual.createModelVisibilityPolicy(params);
    },
  };
});

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  });
  catalogMocks.loadModelCatalog.mockReset();
  catalogMocks.loadModelCatalog.mockResolvedValue([
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
  ]);
  createVisibilityPolicy.mockClear();
  setActivePluginRegistry(createTestRegistry([]));
});

describe("buildModelsProviderData", () => {
  it("builds the visibility policy once per browse", async () => {
    await buildModelsProviderData({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    } as OpenClawConfig);

    expect(createVisibilityPolicy).toHaveBeenCalledTimes(1);
  });

  it("reuses one manifest plugin snapshot across browse normalization", async () => {
    await buildModelsProviderData({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    } as OpenClawConfig);

    const [params] = createVisibilityPolicy.mock.calls.at(0) ?? [];
    expect(params).toHaveProperty("manifestPlugins");
  });
});
