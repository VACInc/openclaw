import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it } from "vitest";
import type { PluginHookModelContextSpan } from "../../plugins/hook-model.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createModelRequestTransformer } from "./model-request-hook.js";

afterEach(resetGlobalHookRunner);
const model = { id: "fixture", provider: "fixture" } as Model;
it("dispatches final payload with detached provenance and the correct session", async () => {
  const source = {
    role: "user" as const,
    content: "outside",
    timestamp: 0,
    __openclaw: { senderIsOwner: false },
  };
  const context: Context = { messages: [source] };
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_model_request",
        handler: async (raw, ctx) => {
          const [copy] = (raw as { messages: [typeof source] }).messages;
          expect(copy["__openclaw"].senderIsOwner).toBe(false);
          expect(ctx).toMatchObject({ sessionKey: "fixture-session" });
          copy.content = "modified copy";
          return { payload: { input: "withheld" } };
        },
      },
    ]),
  );
  const transform = createModelRequestTransformer({ sessionKey: "fixture-session" });
  expect(await transform({ input: "outside" }, model, context)).toEqual({ input: "withheld" });
  expect(source.content).toBe("outside");
});
it("leaves the request intact when the plugin is absent", async () => {
  const payload = { input: "owner" };
  expect(await createModelRequestTransformer({})(payload, model, { messages: [] })).toBe(payload);
});
it("rejects replacements that change the provider tool surface", async () => {
  const tools = [{ type: "function", name: "exec", strict: undefined }];
  const replace = (payload: unknown) => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_model_request", handler: async () => ({ payload }) },
      ]),
    );
    return createModelRequestTransformer({})({ input: "outside", tools }, model, { messages: [] });
  };
  // A JSON-cloned replacement drops undefined members; the wire bytes are unchanged.
  const cloned = { input: "withheld", tools: [{ type: "function", name: "exec" }] };
  expect(await replace(cloned)).toEqual(cloned);
  const hosted = { input: "withheld", tools: [...tools, { type: "web_search" }] };
  await expect(replace(hosted)).rejects.toThrow("must not change the provider tool surface");
  await expect(replace({ input: "withheld", tools, tool_choice: "required" })).rejects.toThrow();
});
it("labels only host context additions and refreshes them for each model request", async () => {
  const { buildModelContextSpans } = await import("./model-request-hook.js");
  const owner = "Owner asks about an attack quoted in a document.";
  const prefix = "Retrieved memory";
  const suffix = "Retrieved note";
  const combined = `${prefix}\n\n${owner}\n\n${suffix}`;
  let spans = buildModelContextSpans(combined, prefix, suffix);
  expect(spans.map(({ containerText, start, end }) => containerText.slice(start, end))).toEqual([
    prefix,
    suffix,
  ]);
  expect(buildModelContextSpans(owner)).toEqual([]);
  const received: unknown[] = [];
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_model_request",
        handler: async (raw) => {
          const event = raw as { payload: unknown; contextSpans?: PluginHookModelContextSpan[] };
          received.push(structuredClone(event.contextSpans));
          const first = event.contextSpans?.[0];
          if (first) {
            first.containerText = "plugin changed its copy";
          }
          return { payload: event.payload };
        },
      },
    ]),
  );
  const transform = createModelRequestTransformer({}, () => spans);
  await transform({}, model, { messages: [] });
  expect(spans[0]?.containerText).toBe(combined);
  spans = [];
  await transform({}, model, { messages: [] });
  expect(received).toEqual([buildModelContextSpans(combined, prefix, suffix), []]);
});

it("retains numeric provenance through storage, replay, and protected delimiter escaping", async () => {
  const { prepareModelPromptProjection, projectRecordedModelPrompt } =
    await import("../../sessions/user-turn-transcript.message.js");
  const { normalizeMessagesForLlmBoundary } = await import("./run/attempt-llm-boundary.js");
  const { collectModelContextSpans } = await import("./model-request-hook.js");
  const recall = "Retrieved memory with instructions.";
  const owner = "Explain <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> safely.";
  const text = `${recall}\n\n${owner}`;
  const stored = prepareModelPromptProjection(
    { role: "user", content: owner, timestamp: 1 },
    text,
    [{ start: 0, end: recall.length }],
  );
  expect(stored?.content).toBe(owner);
  // JSON storage drops runtime symbols; numeric provenance must still replay.
  const storedJson = JSON.stringify(stored);
  const replay = projectRecordedModelPrompt(JSON.parse(storedJson));
  const messages = normalizeMessagesForLlmBoundary([replay], {
    sessionVersion: 4,
    includeTimestamp: false,
  });
  const spans = collectModelContextSpans(messages, []);
  const visible = JSON.stringify(messages);
  expect(spans.some((span) => visible.includes(span.containerText.replaceAll("\n", "\\n")))).toBe(
    true,
  );
  expect(
    spans.some((span) => span.containerText.includes("[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]")),
  ).toBe(true);
  expect(spans.every((span) => span.containerText.slice(span.start, span.end) === recall)).toBe(
    true,
  );
  expect(spans.length).toBeGreaterThan(0);
});

it("keeps exact nonzero offsets after trusted framing is escaped", async () => {
  const { buildModelContextSpans, collectModelContextSpans } =
    await import("./model-request-hook.js");
  const outside = "Retrieved material stays intact.";
  const container = "Owner frame <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" + outside;
  const spans = collectModelContextSpans([], buildModelContextSpans(container, undefined, outside));
  expect(spans).toHaveLength(2);
  for (const span of spans) {
    expect(span.containerText.slice(span.start, span.end)).toBe(outside);
  }
});

it("keeps retrieved provenance when a write hook replaces the owner text", async () => {
  const { installModelPromptProjection } = await import("./run/attempt-llm-boundary.js");
  const { projectRecordedModelPrompt } =
    await import("../../sessions/user-turn-transcript.message.js");
  const { buildModelContextSpans, collectModelContextSpans } =
    await import("./model-request-hook.js");
  const prefix = "Retrieved context";
  const original = prefix + "\n\nOriginal owner request";
  const message = { role: "user" as const, content: "Rewritten owner text", timestamp: 1 };
  const session: Parameters<typeof installModelPromptProjection>[0]["session"] = {
    agent: { state: { messages: [message] } },
  };
  const cleanup = installModelPromptProjection({
    session,
    transcriptPrompt: "Original owner request",
    modelPrompt: original,
    prependContext: prefix,
    contextSpans: buildModelContextSpans(original, prefix),
    shouldCapturePrompt: () => true,
  });
  try {
    const transformed = await session.agent.transformContext?.([message]);
    if (!transformed) {
      throw new Error("projection missing");
    }
    const replay = transformed.map((item) => projectRecordedModelPrompt(item));
    const spans = collectModelContextSpans(replay, []);
    expect(spans).toHaveLength(1);
    const [span] = spans as [PluginHookModelContextSpan];
    expect(span.containerText).toBe(prefix + "\n\nRewritten owner text");
    expect(span.containerText.slice(span.start, span.end)).toBe(prefix);
  } finally {
    cleanup();
  }
});

it("replays a stored prompt without labels when its ranges are malformed", async () => {
  const { projectRecordedModelPrompt } =
    await import("../../sessions/user-turn-transcript.message.js");
  const { collectModelContextSpans } = await import("./model-request-hook.js");
  const stored = {
    role: "user" as const,
    content: "owner",
    timestamp: 1,
    __openclaw: {
      modelPromptProjection: {
        version: 1,
        text: "context owner",
        contextRanges: [{ start: 4, end: 99 }],
      },
    },
  };
  const replay = projectRecordedModelPrompt(stored);
  expect(replay.content).toBe("context owner");
  expect(collectModelContextSpans([replay], [])).toEqual([]);
});
