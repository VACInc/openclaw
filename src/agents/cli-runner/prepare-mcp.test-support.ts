import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  type createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

type McpProjectionParams = Parameters<typeof resolveMcpLoopbackScopedTools>[0];

/** Reuses the preparation suite's backend and lifecycle fixture for MCP admission proof. */
export function registerCliMcpPreparationTests({
  getFixture,
  createConfig,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  createConfig: () => OpenClawConfig;
}) {
  it.each([false, true])(
    "stamps managed shell into the final MCP grant (restricted=%s)",
    async (restricted) => {
      const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
      const resolveMcpLoopbackScopedTools = vi.fn((scope: McpProjectionParams) => ({
        agentId: "main",
        tools: ["exec", "process", "message"]
          .filter((name) => !scope.context.toolsAllow || scope.context.toolsAllow.includes(name))
          .map((name) => ({ name })),
      }));
      setCliRunnerPrepareTestDeps({
        getActiveMcpLoopbackRuntime: vi.fn(() => ({
          port: 31783,
          ownerToken: "loopback-owner-token",
          nonOwnerToken: "loopback-non-owner-token",
        })),
        mintMcpLoopbackClientGrant,
        resolveMcpLoopbackScopedTools,
        resolveMcpLoopbackPolicyTools: resolveMcpLoopbackScopedTools,
      });
      setRawCliBackendForPrepareTest({
        id: "managed-cli",
        pluginId: "managed-plugin",
        bundleMcp: true,
        bundleMcpMode: "claude-config-file",
        nativeToolMode: "selectable",
        hostOwnedTools: ["exec", "process"],
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
        config: {
          command: "managed-cli",
          args: ["--print"],
          output: "jsonl",
          input: "stdin",
          sessionMode: "existing",
        },
      });
      const context = await getFixture().prepare({
        provider: "managed-cli",
        ...(restricted ? { toolsAllow: ["message"] } : {}),
      });
      expect(context.hostOwnedTools).toEqual(restricted ? undefined : ["exec", "process"]);
      expect(mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context.toolsAllow).toEqual(
        restricted ? ["message"] : ["exec", "process", "message"],
      );
    },
  );

  it("binds one live prepared admission to tool projection and the CLI MCP grant", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const bindMcpLoopbackClientGrantAdmission = vi.fn(() => true);
    const resolveMcpLoopbackScopedTools = vi.fn((_scope: McpProjectionParams) => ({
      agentId: "main",
      tools: [],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      resolveMcpLoopbackScopedTools,
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      bindMcpLoopbackClientGrantAdmission,
    });
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      {},
      "run-prepared-mcp",
      "main",
      "cli-mcp-projection",
    );
    try {
      const context = await getFixture().prepare({
        runId: "run-prepared-mcp",
        preparedRunAdmission,
        config: createConfig(),
      });

      try {
        expect(context.params.admittedRunContext.operationalRunInstance).toBe(
          preparedRunAdmission.operationalRunInstance,
        );
        expect(resolveMcpLoopbackScopedTools.mock.calls[0]?.[0].admittedRunContext).toBe(
          context.params.admittedRunContext,
        );
        expect(getAdmittedRunDelegatedAuthority(context.params.admittedRunContext)).toBeDefined();
        expect(bindMcpLoopbackClientGrantAdmission).toHaveBeenCalledExactlyOnceWith({
          token: "loopback-token",
          runtimeOwnerToken: "loopback-owner-token",
          admittedRunContext: context.params.admittedRunContext,
        });
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    } finally {
      preparedRunAdmission.close();
    }
  });
}

export function setRawCliBackendForPrepareTest(backend: CliBackendPlugin & { pluginId: string }) {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
}
