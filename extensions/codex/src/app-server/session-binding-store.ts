/** Lazy store facade that keeps binding schema/auth code off plugin startup. */
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  CODEX_MANAGED_THREAD_BACKFILL_KEY,
  createCodexManagedThreadStore,
  codexHomeFromRolloutPath,
  codexManagedThreadSourceHomeId,
  type CodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
import {
  readStoredCodexAppServerBinding,
  type CodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

export { CODEX_APP_SERVER_BINDING_MAX_ENTRIES, CODEX_APP_SERVER_BINDING_NAMESPACE };
export type { StoredCodexAppServerBinding } from "./session-binding.js";

/** Defers schema compilation and auth loading until the first binding operation. */
export function createLazyCodexAppServerBindingStore(
  state: Pick<
    PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
    "entries" | "lookup" | "update"
  >,
  managedThreadState?: Pick<
    PluginStateSyncKeyedStore<StoredCodexManagedThread>,
    "entries" | "registerIfAbsent"
  >,
): CodexAppServerBindingStore {
  let resolved: Promise<CodexAppServerBindingStore> | undefined;
  const store = () =>
    (resolved ??= import("./session-binding.js").then(({ createCodexAppServerBindingStore }) =>
      createCodexAppServerBindingStore(state),
    ));
  const managedThreads = managedThreadState
    ? (() => {
        const managedStore = createCodexManagedThreadStore(managedThreadState);
        return {
          mark: (params: Parameters<CodexManagedThreadStore["mark"]>[0]) =>
            managedStore.mark(params),
          async snapshot() {
            const migrationComplete = managedThreadState
              .entries()
              .some((entry) => entry.key === CODEX_MANAGED_THREAD_BACKFILL_KEY);
            if (!migrationComplete) {
              for (const entry of state.entries()) {
                const stored = readStoredCodexAppServerBinding(entry.value);
                if (!stored || stored.state !== "active") {
                  continue;
                }
                const binding = stored.binding;
                if (
                  binding.connectionScope === "supervision" &&
                  binding.threadId === binding.supervisionSourceThreadId
                ) {
                  continue;
                }
                const codexHome = binding.rolloutPath
                  ? codexHomeFromRolloutPath(binding.rolloutPath)
                  : undefined;
                if (!codexHome) {
                  continue;
                }
                await managedStore.mark({
                  sourceHomeId: codexManagedThreadSourceHomeId(codexHome),
                  threadId: binding.threadId,
                  rolloutPath: binding.rolloutPath,
                });
              }
              managedThreadState.registerIfAbsent(CODEX_MANAGED_THREAD_BACKFILL_KEY, {
                version: 1,
                kind: "binding-backfill-complete",
              });
            }
            return await managedStore.snapshot();
          },
        };
      })()
    : undefined;
  return {
    ...(managedThreads ? { managedThreads } : {}),
    read: async (identity) => (await store()).read(identity),
    hasOtherThreadOwner: async (threadId, currentIdentity) =>
      (await store()).hasOtherThreadOwner(threadId, currentIdentity),
    mutate: async (identity, mutation) => (await store()).mutate(identity, mutation),
    prepareSessionGenerationReclaim: async (identity) =>
      (await store()).prepareSessionGenerationReclaim(identity),
    adoptSessionGeneration: async (identity, previousSessionId) =>
      (await store()).adoptSessionGeneration(identity, previousSessionId),
    resetSessionGeneration: async (identity) => (await store()).resetSessionGeneration(identity),
    retireSessionGeneration: async (identity) => (await store()).retireSessionGeneration(identity),
    withThreadArchiveFence: async (run) => (await store()).withThreadArchiveFence(run),
    withLease: async (identity, run) => (await store()).withLease(identity, run),
  };
}
