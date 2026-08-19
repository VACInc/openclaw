import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearConfigCache } from "../config/config.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { installGatewayTestHooks, rpcReq, startConnectedServerWithClient } from "./test-helpers.js";

installGatewayTestHooks();

afterEach(() => {
  vi.restoreAllMocks();
});

const CHAT_METADATA_BOUNDARY_CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-boundary" },
      models: { "openai/gpt-boundary": {} },
    },
    entries: { main: { default: true } },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://openai.example.com/v1",
        models: [{ id: "gpt-boundary", name: "GPT Boundary" }],
      },
    },
  },
} as const;

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  clearConfigCache();
}

async function withProductionChatMetadataGateway(
  run: (ws: Awaited<ReturnType<typeof startConnectedServerWithClient>>["ws"]) => Promise<void>,
) {
  const envSnapshot = captureEnv(["OPENCLAW_TEST_MINIMAL_GATEWAY"]);
  let started: Awaited<ReturnType<typeof startConnectedServerWithClient>> | undefined;
  try {
    // The production lifecycle has no refresh-on-read escape hatch. This must stay non-minimal,
    // otherwise the old sticky behavior is hidden by the test-only lifecycle configuration.
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
    await writeGatewayConfig(CHAT_METADATA_BOUNDARY_CONFIG);
    started = await startConnectedServerWithClient();
    await run(started.ws);
  } finally {
    if (started) {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
    clearConfigCache();
    envSnapshot.restore();
  }
}

test("chat.metadata recovers a published prepared-owner capture miss on the next Gateway read", async () => {
  await withProductionChatMetadataGateway(async (ws) => {
    const preparedModelCatalog = await import("../agents/prepared-model-catalog.js");
    const publicationEvents =
      await import("../agents/prepared-model-runtime.publication-events.js");
    const originalGetPreparedOwner = preparedModelCatalog.getPreparedModelCatalogOwnerSnapshot;
    const initial = await rpcReq(ws, "chat.metadata", { agentId: "main" });
    expect(initial.ok).toBe(true);

    let ownerVisible = false;
    const ownerCaptureMissed = createDeferred();
    vi.spyOn(preparedModelCatalog, "getPreparedModelCatalogOwnerSnapshot").mockImplementation(
      (params) => {
        if (!ownerVisible) {
          ownerCaptureMissed.resolve();
          return undefined;
        }
        return originalGetPreparedOwner(params);
      },
    );

    // This is the lifecycle listener's real published catch-up. The owner exists, but this one
    // capture sees it missing, reproducing the stale publication announcement that wedged UI.
    publicationEvents.notifyPreparedModelRuntimePublication({ phase: "published" });
    await ownerCaptureMissed.promise;
    const unavailable = await rpcReq(ws, "chat.metadata", { agentId: "main" });
    expect(unavailable).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("prepared chat metadata owner is unavailable"),
      },
    });

    ownerVisible = true;
    const recovered = await rpcReq<{
      models?: Array<{ id?: string; provider?: string }>;
    }>(ws, "chat.metadata", { agentId: "main" });

    // On the merge-base this remains false: readCurrent rethrows the cached unavailable error.
    expect(recovered.ok).toBe(true);
    expect(recovered.payload?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "gpt-boundary", provider: "openai" })]),
    );
  });
});

test("chat.metadata does not retry a cached non-owner failure without lifecycle invalidation", async () => {
  await withProductionChatMetadataGateway(async (ws) => {
    const publicationEvents =
      await import("../agents/prepared-model-runtime.publication-events.js");
    const modelsListResult = await import("./server-methods/models-list-result.js");
    const initial = await rpcReq(ws, "chat.metadata", { agentId: "main" });
    expect(initial.ok).toBe(true);
    const projectionFailure = new Error("configured model catalog unavailable");
    const projectionSpy = vi
      .spyOn(modelsListResult, "buildModelsListResult")
      .mockRejectedValue(projectionFailure);

    publicationEvents.notifyPreparedModelRuntimePublication({ phase: "published" });
    await vi.waitFor(() => expect(projectionSpy).toHaveBeenCalled(), {
      interval: 1,
      timeout: 2_000,
    });
    const unavailable = await rpcReq(ws, "chat.metadata", { agentId: "main" });
    expect(unavailable).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("configured model catalog unavailable"),
      },
    });

    projectionSpy.mockRestore();
    const stillUnavailable = await rpcReq(ws, "chat.metadata", { agentId: "main" });

    // A broad retry would turn this into a false recovery and hide a genuinely broken catalog.
    expect(stillUnavailable).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("configured model catalog unavailable"),
      },
    });
  });
});
