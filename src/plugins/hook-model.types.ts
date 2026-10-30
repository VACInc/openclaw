import type { PluginHookAgentContext } from "./hook-agent-context.types.js";
import type { AsyncPluginHook } from "./hook-handler.types.js";
import type {
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookModelCallStartedEvent,
  PluginHookModelCallEndedEvent,
} from "./hook-types.js";

/** Host-owned ranges of retrieved context in an assembled user prompt. */
export type PluginHookModelContextSpan = {
  containerText: string;
  start: number;
  end: number;
};

export type ModelHooks = {
  model_call_started: AsyncPluginHook<PluginHookModelCallStartedEvent, PluginHookAgentContext>;
  model_call_ended: AsyncPluginHook<PluginHookModelCallEndedEvent, PluginHookAgentContext>;
  before_model_request: AsyncPluginHook<
    {
      payload: unknown;
      provider: string;
      model: string;
      messages: readonly unknown[];
      contextSpans?: readonly PluginHookModelContextSpan[];
    },
    PluginHookAgentContext,
    { payload: unknown }
  >;
  llm_input: AsyncPluginHook<PluginHookLlmInputEvent, PluginHookAgentContext>;
  llm_output: AsyncPluginHook<PluginHookLlmOutputEvent, PluginHookAgentContext>;
};

export const MODEL_HOOK_METADATA = {
  before_model_request: {
    conversationAccess: true,
    promptInjection: true,
    modifyingTimeoutMs: 10000,
  },
  model_call_started: {},
  model_call_ended: {},
  llm_input: { conversationAccess: true },
  llm_output: { conversationAccess: true },
} as const;
