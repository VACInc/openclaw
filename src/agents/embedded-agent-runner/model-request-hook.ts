import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type { PluginHookModelContextSpan } from "../../plugins/hook-model.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { MODEL_CONTEXT_SPANS } from "../../sessions/user-turn-transcript.message.js";
import { escapeInternalRuntimeContextDelimiters } from "../internal-runtime-context.js";
import { buildEmbeddedAgentHookContext } from "./run/agent-hook-context.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

// Provider-hosted tools run remotely with no later local gate, and their authorization
// is settled before this hook. Content policy may rewrite messages, never the tool surface.
const TOOL_SURFACE_FIELDS = ["tools", "tool_choice", "toolConfig", "functions", "function_call"];

/** Wire view of the tool fields: JSON drops undefined members a cloned replacement loses. */
function readToolSurface(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "[]";
  }
  const config: unknown = Reflect.get(payload, "config");
  const nested = typeof config === "object" && config !== null ? config : {};
  const fields = [payload, nested].flatMap((owner) =>
    TOOL_SURFACE_FIELDS.map((field) => Reflect.get(owner, field)),
  );
  return JSON.stringify(fields);
}

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
  messages: readonly object[],
  fresh: readonly PluginHookModelContextSpan[],
): PluginHookModelContextSpan[] {
  const inherited = messages.flatMap(
    (message) =>
      // SAFETY: only host prompt projection defines this non-enumerable symbol, always with spans.
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
    if (!result) {
      return payload;
    }
    if (readToolSurface(result.payload) !== readToolSurface(payload)) {
      throw new Error("before_model_request replacement must not change the provider tool surface");
    }
    return result.payload;
  };
}

/** Binds the final request gate to the attempt's agent hook context. */
export function createAttemptModelRequestTransformer(
  attempt: EmbeddedRunAttemptParams,
  agentId: string,
  getContextSpans: () => readonly PluginHookModelContextSpan[],
) {
  return createModelRequestTransformer(
    {
      ...buildEmbeddedAgentHookContext(attempt, agentId, undefined),
      modelProviderId: attempt.model.provider,
      modelId: attempt.model.id,
    },
    getContextSpans,
  );
}
