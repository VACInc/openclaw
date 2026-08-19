import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(() => [
    { agentDir: "/tmp/main", authPath: "/tmp/main/auth-profiles.json" },
  ]),
  loadStore: vi.fn(() => null),
  resolveExternalCliAuthProfiles: vi.fn<() => unknown[]>(() => []),
  runTransaction: vi.fn((_agentDir, callback) => callback({})),
  saveStore: vi.fn(),
}));

vi.mock("./doctor-auth-legacy-paths.js", () => ({
  listAuthProfileRepairCandidates: mocks.listCandidates,
}));
vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: mocks.loadStore,
}));
vi.mock("../agents/auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: mocks.resolveExternalCliAuthProfiles,
}));
vi.mock("../agents/auth-profiles/sqlite.js", () => ({
  runAuthProfileWriteTransaction: mocks.runTransaction,
}));
vi.mock("../agents/auth-profiles/store.js", () => ({ saveAuthProfileStore: mocks.saveStore }));

import { maybeMigrateExternalCliProfileMetadata } from "./doctor-external-cli-profiles.js";

afterEach(() => vi.clearAllMocks());

describe("external CLI auth profile doctor migration", () => {
  it("persists the CLI credential before canonicalizing legacy Claude metadata", () => {
    const profileId = "anthropic:claude-cli";
    mocks.resolveExternalCliAuthProfiles.mockReturnValueOnce([
      {
        profileId,
        persistence: "persisted",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 60_000,
        },
      },
    ]);
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "claude-cli", mode: "oauth" });
    expect(mocks.resolveExternalCliAuthProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ profiles: {} }),
      expect.objectContaining({ profileIds: [profileId], allowKeychainPrompt: false }),
    );
    expect(mocks.saveStore).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.objectContaining({
          [profileId]: expect.objectContaining({ type: "oauth" }),
        }),
      }),
      "/tmp/main",
      { syncExternalCli: false },
      {},
    );
    expect(result).toMatchObject({ configChanged: true, warnings: [] });
  });

  it("keeps legacy metadata when no current CLI credential can be persisted", () => {
    const profileId = "anthropic:claude-cli";
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "anthropic", mode: "token" });
    expect(mocks.saveStore).not.toHaveBeenCalled();
    expect(result).toMatchObject({ configChanged: false });
    expect(result.warnings).toContain(
      "Kept legacy external CLI metadata for anthropic:claude-cli: OAuth credentials were not imported and saved for every auth profile store.",
    );
  });

  it("keeps legacy metadata when the credential store write fails", () => {
    const profileId = "anthropic:claude-cli";
    mocks.resolveExternalCliAuthProfiles.mockReturnValueOnce([
      {
        profileId,
        persistence: "persisted",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 60_000,
        },
      },
    ]);
    mocks.runTransaction.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    const cfg = {
      auth: { profiles: { [profileId]: { provider: "anthropic", mode: "token" } } },
    } as OpenClawConfig;

    const result = maybeMigrateExternalCliProfileMetadata({ cfg, env: {} });

    expect(cfg.auth?.profiles?.[profileId]).toEqual({ provider: "anthropic", mode: "token" });
    expect(result).toMatchObject({ configChanged: false });
    expect(result.warnings).toContain(
      "Could not persist external CLI OAuth credentials for /tmp/main: database unavailable",
    );
  });
});
