import { describe, expect, it } from "vitest";
import provider from "./provider-discovery.js";

describe("OpenCode provider discovery", () => {
  it("resolves Ox Alpha anonymous auth without loading the full plugin", () => {
    expect(provider.resolveSyntheticAuth?.({ modelId: "x-preview-f-free" } as never)).toEqual({
      apiKey: "opencode-zen-anonymous",
      source: "OpenCode Zen Ox Alpha Free (anonymous route)",
      mode: "api-key",
    });
    expect(
      provider.resolveSyntheticAuth?.({ modelId: "deepseek-v4-flash-free" } as never),
    ).toBeUndefined();
  });
});
