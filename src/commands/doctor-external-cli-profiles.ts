/** Doctor-owned migration for legacy external CLI profile metadata and credentials. */
import { isDeepStrictEqual } from "node:util";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  listConfiguredExternalCliProfileMetadataIds,
  normalizeExternalCliProfileMetadata,
} from "../agents/auth-profiles/external-cli-profile-metadata.js";
import { resolveExternalCliAuthProfiles } from "../agents/auth-profiles/external-cli-sync.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { runAuthProfileWriteTransaction } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAuthProfileRepairCandidates } from "./doctor-auth-legacy-paths.js";

type DoctorExternalCliProfileMigration = {
  changes: string[];
  warnings: string[];
  configChanged: boolean;
};

/**
 * Doctor is the sole durable migration owner. Runtime recognizes this legacy
 * spelling only to keep a live install recoverable until this repair is run.
 */
export function maybeMigrateExternalCliProfileMetadata(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): DoctorExternalCliProfileMigration {
  const env = params.env ?? process.env;
  const profiles = params.cfg.auth?.profiles;
  const profileIds = listConfiguredExternalCliProfileMetadataIds(profiles);
  if (profileIds.length === 0 || !profiles) {
    return { changes: [], warnings: [], configChanged: false };
  }

  let configChanged = false;
  for (const profileId of profileIds) {
    const current = profiles[profileId];
    const canonical = normalizeExternalCliProfileMetadata(profileId, current);
    if (!current || !canonical) {
      continue;
    }
    if (current.provider !== canonical.provider || current.mode !== canonical.mode) {
      profiles[profileId] = { ...current, ...canonical };
      configChanged = true;
    }
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  for (const candidate of listAuthProfileRepairCandidates(params.cfg, env)) {
    const existing =
      loadPersistedAuthProfileStore(candidate.agentDir) ??
      ({ version: AUTH_STORE_VERSION, profiles: {} } as const);
    const imported = resolveExternalCliAuthProfiles(existing, {
      profileIds,
      allowKeychainPrompt: false,
    }).filter((profile) => profile.persistence === "persisted");
    if (imported.length === 0) {
      continue;
    }
    const next = {
      ...existing,
      profiles: {
        ...existing.profiles,
        ...Object.fromEntries(imported.map((profile) => [profile.profileId, profile.credential])),
      },
    };
    if (isDeepStrictEqual(next, existing)) {
      continue;
    }
    try {
      runAuthProfileWriteTransaction(candidate.agentDir, (database) => {
        const authoritative =
          loadPersistedAuthProfileStore(candidate.agentDir, { database }) ??
          ({ version: AUTH_STORE_VERSION, profiles: {} } as const);
        if (!isDeepStrictEqual(authoritative, existing)) {
          throw new Error("auth profile store changed during external CLI migration");
        }
        saveAuthProfileStore(next, candidate.agentDir, { syncExternalCli: false }, database);
      });
      changes.push(
        `Migrated external CLI OAuth profile metadata for ${candidate.agentDir ?? "main"}.`,
      );
    } catch (error) {
      warnings.push(
        `Could not persist external CLI OAuth credentials for ${candidate.agentDir ?? "main"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (configChanged) {
    changes.unshift("Migrated legacy external CLI auth.profiles metadata to OAuth.");
  }
  return { changes, warnings, configChanged };
}
