/**
 * Channel runtime context registry types.
 *
 * Defines the public plugin SDK surface for channel runtime context registration and watches.
 */
export type ChannelRuntimeContextKey = {
  channelId: string;
  accountId?: string | null;
  capability: string;
};

export type ChannelRuntimeContextEvent = {
  type: "registered" | "unregistered";
  key: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
  context?: unknown;
};

export type ChannelRuntimeContextRegistry = {
  register: (
    params: ChannelRuntimeContextKey & {
      context: unknown;
      abortSignal?: AbortSignal;
    },
  ) => { dispose: () => void };
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Runtime context values are caller-typed by key.
  get: <T = unknown>(params: ChannelRuntimeContextKey) => T | undefined;
  watch: (params: {
    channelId?: string;
    accountId?: string | null;
    capability?: string;
    onEvent: (event: ChannelRuntimeContextEvent) => void;
  }) => () => void;
};

/** Minimal result contract lets adapters carry the prepared dispatcher without importing reply runtime. */
export type ChannelRuntimeReplyDispatchResult = {
  queuedFinal: boolean;
  counts: Record<"tool" | "block" | "final", number>;
};

/** Prepared dispatcher passed to the inbound-turn owner, never invoked by adapters. */
export type ChannelRuntimeReplyDispatcher = {
  dispatch(params: unknown): Promise<ChannelRuntimeReplyDispatchResult>;
}["dispatch"];

/**
 * Minimal channel-runtime surface exported through the public plugin SDK.
 *
 * Gateway startup supplies the full plugin channel runtime, but external callers
 * may still type context-only helpers against this compatibility surface.
 */
export type ChannelRuntimeSurface = {
  runtimeContexts: ChannelRuntimeContextRegistry;
  // Direct adapters retain this closure-bound dispatcher across detached ingress work.
  reply?: {
    dispatchReplyFromConfig: ChannelRuntimeReplyDispatcher;
  };
  [key: string]: unknown;
};
