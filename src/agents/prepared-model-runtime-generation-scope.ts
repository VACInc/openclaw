import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

const preparedModelRuntimePluginGenerationScope = new AsyncLocalStorage<
  PreparedModelRuntimePluginGeneration | undefined
>();

/** Keeps the exact admitted generation available to nested embedded agent runs. */
export function withPreparedModelRuntimePluginGenerationScope<T>(
  generation: PreparedModelRuntimePluginGeneration,
  run: () => T,
): T {
  return preparedModelRuntimePluginGenerationScope.run(generation, run);
}

/** Exact admitted generation active for nested prepared model-runtime acquisition. */
export function getPreparedModelRuntimePluginGeneration():
  | PreparedModelRuntimePluginGeneration
  | undefined {
  return preparedModelRuntimePluginGenerationScope.getStore();
}
