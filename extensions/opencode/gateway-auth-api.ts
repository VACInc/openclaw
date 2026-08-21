import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENCODE_ZEN_OX_ALPHA_MODEL_ID } from "./provider-catalog.js";

const OPENCODE_ZEN_ANONYMOUS_AUTH_MARKER = "opencode-zen-anonymous";

/** Resolves the one Zen model OpenCode currently serves without a key. */
export function resolveOpencodeZenAnonymousAuth(modelId: string | undefined) {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  const bareModelId = normalized.startsWith("opencode/")
    ? normalized.slice("opencode/".length)
    : normalized;
  return bareModelId === OPENCODE_ZEN_OX_ALPHA_MODEL_ID
    ? {
        apiKey: OPENCODE_ZEN_ANONYMOUS_AUTH_MARKER,
        source: "OpenCode Zen Ox Alpha Free (anonymous route)",
        mode: "api-key" as const,
      }
    : undefined;
}
