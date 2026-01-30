export type HookContextShape = Record<string, unknown>;

export function buildInternalHookContext<
  TFull extends HookContextShape,
  TSafe extends HookContextShape,
>(includeSensitive: boolean, full: TFull, safe: TSafe): TFull | TSafe {
  return includeSensitive ? full : safe;
}

export function summarizeText(text?: string | null) {
  const value = typeof text === "string" ? text : "";
  return {
    hasText: value.length > 0,
    textLength: value.length,
  };
}

export function summarizeMediaUrls(urls?: string[] | null) {
  const list = Array.isArray(urls) ? urls.filter((url) => Boolean(url?.trim())) : [];
  return {
    hasMedia: list.length > 0,
    mediaCount: list.length,
  };
}
