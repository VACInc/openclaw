import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";

/** Policy sees final provider bytes and a detached copy of host message provenance. */
export function createModelRequestTransformer(hookContext: PluginHookAgentContext) {
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
      },
      hookContext,
    );
    return result ? result.payload : payload;
  };
}
