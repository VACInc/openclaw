import { AsyncLocalStorage } from "node:async_hooks";

const invocation = new AsyncLocalStorage<{ pluginId: string; toolName: string }>();

/** The actual registered tool name, not a plugin-provided callback destination. */
export function withPluginToolCallbackInvocation<T>(
  pluginId: string,
  toolName: string,
  run: () => T,
): T {
  return invocation.run({ pluginId, toolName }, run);
}

export function getPluginToolCallbackInvocation():
  | { pluginId: string; toolName: string }
  | undefined {
  return invocation.getStore();
}
