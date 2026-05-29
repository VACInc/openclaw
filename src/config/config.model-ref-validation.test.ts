import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

const SPARK_MODEL = "gpt-5.3-codex-spark";
const SPARK_REASON =
  "gpt-5.3-codex-spark is a Codex OAuth research preview and is not exposed on direct OpenAI API-key routes. Use openai/gpt-5.3-codex-spark with the native Codex runtime or openai-codex/gpt-5.3-codex-spark.";

function createOpenAISparkRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        channels: [],
        providers: ["openai", "openai-codex"],
        contracts: {},
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: "/tmp/plugins/openai",
        source: "test",
        manifestPath: "/tmp/plugins/openai/openclaw.plugin.json",
        modelCatalog: {
          providers: {
            "openai-codex": {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [
                { id: SPARK_MODEL },
                { id: "gpt-5.4-mini" },
                { id: "gpt-5.2-codex" },
                { id: "gpt-5.3-codex" },
              ],
            },
          },
          suppressions: [
            {
              provider: "openai",
              model: SPARK_MODEL,
              reason: SPARK_REASON,
            },
          ],
        },
      },
    ],
  };
}

describe("config model reference validation", () => {
  it("rejects suppressed direct OpenAI Spark refs when the ref stays on OpenClaw runtime", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.3-codex-spark": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createOpenAISparkRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.models.openai/gpt-5.3-codex-spark",
        message: `Unknown model: openai/gpt-5.3-codex-spark. ${SPARK_REASON}`,
      },
    ]);
  });

  it("accepts suppressed OpenAI Spark refs when native Codex runtime owns the route", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.3-codex-spark": {
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createOpenAISparkRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts supported openai-codex provider/model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4-mini",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createOpenAISparkRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts available openai-codex fallback model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4-mini",
              fallbacks: ["openai-codex/gpt-5.2-codex", "openai-codex/gpt-5.3-codex"],
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createOpenAISparkRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });
});
