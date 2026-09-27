import { AsyncLocalStorage } from "node:async_hooks";
import { createSubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../state/agent-deletion-journal.read.js";

export function createSessionRowProjectionOwner() {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const discoveryRead = prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime");
  const subagents = createSubagentSessionListReadView({ env });
  return { inOwnerContext, env, discoveryRead, subagents };
}
