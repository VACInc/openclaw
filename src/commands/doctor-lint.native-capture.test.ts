import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import * as pluginCache from "../plugins/plugin-cache.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { capturePluginGenerationArtifact } from "../plugins/plugin-generation-artifact.js";
import { preparePluginNativeAdmissions } from "../plugins/plugin-native-admission-state.js";
import { createNativeAdmissionFixture } from "../plugins/plugin-native-admission.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const checks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: checks.resolve,
}));

it("keeps later native plugin capture independent of retired Doctor snapshots", async () => {
  await withOpenClawTestState({ prefix: "doctor-native-capture-" }, async (state) => {
    await state.writeConfig({
      agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
      memory: { search: { enabled: false } },
      plugins: { enabled: false },
    });
    const fixture = createNativeAdmissionFixture(state.path("installed"), true);
    const source = fixture.root;
    fs.writeFileSync(path.join(source, "README.md"), "unchanged native companion");
    const id = "core/doctor/runtime-tool-schemas";
    checks.resolve.mockResolvedValue([
      {
        id,
        kind: "core",
        description: "inspect native plugin",
        async detect() {
          expect(process.env.OPENCLAW_STATE_DIR).not.toBe(state.stateDir);
          await writePersistedInstalledPluginIndex(fixture.index);
          preparePluginNativeAdmissions(fixture.index);
          const artifact = capturePluginGenerationArtifact(source);
          try {
            artifact.assertSourceCurrent();
          } finally {
            await artifact.disposeAsync();
          }
          return [];
        },
      },
    ]);
    clearHealthChecksForTest();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await using cache = createPluginCache();
    try {
      await withPluginCache(cache, async () => {
        await expect(
          runDoctorLintCli(createTestRuntime(), { json: true, onlyIds: [id] }),
        ).resolves.toBe(0);
        const next = capturePluginGenerationArtifact(source);
        try {
          next.assertSourceCurrent();
          expect(fs.readFileSync(next.resolve(path.join(source, "README.md")), "utf8")).toBe(
            "unchanged native companion",
          );
        } finally {
          await next.disposeAsync();
        }
      });
    } finally {
      stdout.mockRestore();
      clearHealthChecksForTest();
    }
  });
});

it("retains private snapshot bytes when plugin cache retirement reports a failure", async () => {
  await withOpenClawTestState({ prefix: "doctor-native-retirement-" }, async (state) => {
    await state.writeConfig({
      plugins: { enabled: false },
      memory: { search: { enabled: false } },
    });
    openOpenClawStateDatabase();
    let privateState: string | undefined;
    const id = "core/doctor/runtime-tool-schemas";
    checks.resolve.mockResolvedValue([
      {
        id,
        kind: "core",
        description: "inspect private plugin state",
        async detect() {
          privateState = process.env.OPENCLAW_STATE_DIR;
          return [];
        },
      },
    ]);
    clearHealthChecksForTest();
    const actualRetire = pluginCache.retirePluginCache;
    const retire = vi
      .spyOn(pluginCache, "retirePluginCache")
      .mockImplementationOnce(async (...args) => {
        const result = await actualRetire(...args);
        return {
          ...result,
          failures: [
            {
              pluginId: "fixture",
              hookId: "instance",
              error: new Error("synthetic capture retirement failure"),
            },
          ],
        };
      });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(createTestRuntime(), { json: true, onlyIds: [id] }),
      ).resolves.toBe(1);
      expect(String(stdout.mock.calls.at(-1)?.[0])).toContain(
        "synthetic capture retirement failure",
      );
      expect(privateState).toBeDefined();
      expect(privateState).not.toBe(state.stateDir);
      expect(fs.existsSync(privateState!)).toBe(true);
    } finally {
      stdout.mockRestore();
      retire.mockRestore();
      clearHealthChecksForTest();
      await cleanupSnapshotOperations();
    }
  });
});
