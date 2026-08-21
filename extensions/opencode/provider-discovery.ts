// Opencode Zen provider module exposes offline catalog metadata to core discovery.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveOpencodeZenAnonymousAuth } from "./gateway-auth-api.js";
import { buildStaticOpencodeZenProviderConfig } from "./provider-catalog.js";

const opencodeProviderDiscovery: ProviderPlugin = {
  id: "opencode",
  label: "OpenCode Zen",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ modelId }) => resolveOpencodeZenAnonymousAuth(modelId),
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildStaticOpencodeZenProviderConfig(),
    }),
  },
};

export default opencodeProviderDiscovery;
