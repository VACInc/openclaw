import { describe, expect, it } from "vitest";
import { resolvePromptHistoryLimit } from "../../plugin-sdk/number-runtime.js";

describe("private channel history numeric policy", () => {
  it("applies channel defaults, explicit disablement, and the prompt ceiling", () => {
    expect(resolvePromptHistoryLimit(undefined).limit).toBe(50);
    expect(resolvePromptHistoryLimit(12).limit).toBe(12);
    expect(resolvePromptHistoryLimit(Number.MAX_SAFE_INTEGER).limit).toBe(50);
    expect(resolvePromptHistoryLimit(Number.MAX_SAFE_INTEGER, 10).limit).toBe(10);
    expect(resolvePromptHistoryLimit(0, 10).limit).toBe(0);
    expect(resolvePromptHistoryLimit(5000, 10).limit).toBe(200);
  });

  it("distinguishes the schema sentinel from ordinary clamping and missing input", () => {
    expect(resolvePromptHistoryLimit(Number.MAX_SAFE_INTEGER, 10)).toEqual({
      limit: 10,
      isSchemaMaximum: true,
    });
    expect(resolvePromptHistoryLimit(5000)).toEqual({ limit: 200, isSchemaMaximum: false });
    expect(resolvePromptHistoryLimit(undefined)).toEqual({ limit: 50, isSchemaMaximum: false });
    expect(resolvePromptHistoryLimit(0)).toEqual({ limit: 0, isSchemaMaximum: false });
  });

  it.each([undefined, Number.MAX_SAFE_INTEGER])("bounds fallback windows for %s", (configured) => {
    expect(resolvePromptHistoryLimit(configured, 5000).limit).toBe(200);
    expect(resolvePromptHistoryLimit(configured, -1).limit).toBe(0);
    expect(resolvePromptHistoryLimit(configured, Number.POSITIVE_INFINITY).limit).toBe(0);
  });
});
