import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type { PluginHookModelContextSpan } from "../../plugins/hook-model.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { MODEL_CONTEXT_SPANS } from "../../sessions/user-turn-transcript.message.js";
import { escapeInternalRuntimeContextDelimiters } from "../internal-runtime-context.js";

/** Label only additive context, before any provider framing joins it to owner text. */
export function buildModelContextSpans(
  containerText: string,
  prependContext?: string,
  appendContext?: string,
): PluginHookModelContextSpan[] {
  return [
    ...(prependContext ? [{ containerText, start: 0, end: prependContext.length }] : []),
    ...(appendContext
      ? [
          {
            containerText,
            start: containerText.length - appendContext.length,
            end: containerText.length,
          },
        ]
      : []),
  ];
}

/** Preserve captured provenance on replay and apply the host's wire escaping. */
export function collectModelContextSpans(
  messages: Context["messages"],
  fresh: readonly PluginHookModelContextSpan[],
): PluginHookModelContextSpan[] {
  const inherited = messages.flatMap(
    (message) =>
      (Reflect.get(message, MODEL_CONTEXT_SPANS) as PluginHookModelContextSpan[] | undefined) ?? [],
  );
  const unique = new Map<string, PluginHookModelContextSpan>();
  for (const span of [...inherited, ...fresh]) {
    const escaped = escapeInternalRuntimeContextDelimiters(span.containerText);
    const variants = [span];
    if (escaped !== span.containerText) {
      variants.push({
        containerText: escaped,
        start: escapeInternalRuntimeContextDelimiters(span.containerText.slice(0, span.start))
          .length,
        end: escapeInternalRuntimeContextDelimiters(span.containerText.slice(0, span.end)).length,
      });
    }
    for (const variant of variants) {
      unique.set(JSON.stringify(variant), variant);
    }
  }
  return [...unique.values()];
}

/** Policy sees final provider bytes and a detached copy of host message provenance. */
export function createModelRequestTransformer(
  hookContext: PluginHookAgentContext,
  getContextSpans: () => readonly PluginHookModelContextSpan[] = () => [],
) {
  return async (payload: unknown, model: Model, context: Context): Promise<unknown> => {
    const hooks = getGlobalHookRunner();
    if (!hooks?.hasHooks("before_model_request")) {
      return payload;
    }
    const result = await hooks.runBeforeModelRequest(
      {
        payload,
        provider: model.provider,
        model: model.id,
        messages: structuredClone(context.messages),
        contextSpans: structuredClone(
          collectModelContextSpans(context.messages, getContextSpans()),
        ),
      },
      hookContext,
    );
    return result ? result.payload : payload;
  };
}
