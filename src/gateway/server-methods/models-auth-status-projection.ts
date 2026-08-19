import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { ModelAuthStatusProvider } from "./models-auth-status.types.js";

/**
 * A runtime-owned CLI credential is the fact for its canonical usage provider.
 * Do not publish an empty synthetic alias row that contradicts that credential
 * and forces each client surface to rediscover alias ownership independently.
 */
export function suppressSyntheticAliasRowsCoveredByExternalCli(
  providers: ModelAuthStatusProvider[],
  externalCliProfileIds: ReadonlySet<string>,
): ModelAuthStatusProvider[] {
  const coveredProviderIds = new Set(
    providers.flatMap((provider) =>
      provider.profiles.some(
        (profile) => profile.type === "oauth" && externalCliProfileIds.has(profile.profileId),
      )
        ? [resolveUsageProviderId(provider.provider)]
        : [],
    ),
  );
  return providers.filter((provider) => {
    const usageProvider = resolveUsageProviderId(provider.provider);
    return !(
      provider.status === "missing" &&
      provider.profiles.length === 0 &&
      !provider.apiKey &&
      usageProvider !== undefined &&
      coveredProviderIds.has(usageProvider)
    );
  });
}
