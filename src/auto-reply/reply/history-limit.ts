// Shared numeric policy for automatic prompt history and its Doctor migration facts.
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;
/** Hard cap for prompt-injected history windows. JSON-schema integer maximum is not a window. */
const MAX_PROMPT_HISTORY_LIMIT = 200;

/** Resolves one automatic-history window and its schema-maximum migration provenance. */
export function resolvePromptHistoryLimit(
  configured: unknown,
  fallback: number = DEFAULT_GROUP_HISTORY_LIMIT,
): Readonly<{ limit: number; isSchemaMaximum: boolean }> {
  const isSchemaMaximum =
    typeof configured === "number" &&
    Number.isInteger(configured) &&
    configured >= Number.MAX_SAFE_INTEGER;
  const selected =
    typeof configured === "number" && Number.isFinite(configured) && !isSchemaMaximum
      ? configured
      : fallback;
  const limit = Number.isFinite(selected)
    ? Math.min(Math.max(0, Math.trunc(selected)), MAX_PROMPT_HISTORY_LIMIT)
    : 0;
  return { limit, isSchemaMaximum };
}
