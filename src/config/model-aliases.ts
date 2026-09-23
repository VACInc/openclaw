/** Names attached to one model entry. `alias` remains the legacy first name. */
export function getConfiguredModelAliases(entry: {
  alias?: string;
  aliases?: readonly string[];
} | undefined): string[] {
  const names = [entry?.alias, ...(entry?.aliases ?? [])];
  const seen = new Set<string>();
  return names.flatMap((name) => {
    const trimmed = name?.trim();
    const key = trimmed?.toLowerCase();
    if (!trimmed || !key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [trimmed];
  });
}
