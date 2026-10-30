import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it } from "vitest";
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
          const event = raw as { messages: (typeof source)[]; payload: unknown };
          expect(event.messages[0]["__openclaw"].senderIsOwner).toBe(false);
          expect(ctx).toMatchObject({ sessionKey: "fixture-session" });
          event.messages[0].content = "modified copy";
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
        handler: async (event) => {
          received.push(structuredClone(event.contextSpans));
          if (event.contextSpans?.length) {
            event.contextSpans[0].containerText = "plugin changed its copy";
          }
          return { payload: event.payload };
        },
      },
    ]),
  );
  const transform = createModelRequestTransformer({}, () => spans);
  await transform({}, model, { messages: [] });
  expect(spans[0].containerText).toBe(combined);
  spans = [];
  await transform({}, model, { messages: [] });
  expect(received).toEqual([buildModelContextSpans(combined, prefix, suffix), []]);
});
