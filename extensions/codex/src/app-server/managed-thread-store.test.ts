import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  codexHomeFromRolloutPath,
  codexManagedThreadSourceHomeId,
  createCodexManagedThreadStore,
  type StoredCodexManagedThread,
} from "./managed-thread-store.js";

function createStateStore() {
  const values = new Map<string, StoredCodexManagedThread>();
  const state: Pick<
    PluginStateSyncKeyedStore<StoredCodexManagedThread>,
    "entries" | "registerIfAbsent"
  > = {
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
  return { state, values };
}

describe("Codex managed thread store", () => {
  it("records one durable ownership row per home and thread", async () => {
    const { state, values } = createStateStore();
    const store = createCodexManagedThreadStore(state);
    const sourceHomeId = codexManagedThreadSourceHomeId("/tmp/codex-home");

    await store.mark({ sourceHomeId, threadId: "thread-1", rolloutPath: "/rollout.jsonl" });
    await store.mark({ sourceHomeId, threadId: "thread-1", rolloutPath: "/new-path.jsonl" });

    expect(values.size).toBe(1);
    expect([...values.values()][0]).toMatchObject({
      kind: "managed-thread",
      sourceHomeId,
      threadId: "thread-1",
      rolloutPath: "/rollout.jsonl",
    });
    await expect(store.snapshot()).resolves.toEqual(
      new Map([[sourceHomeId, new Set(["thread-1"])]]),
    );
  });

  it("ignores malformed rows when building a snapshot", async () => {
    const { state, values } = createStateStore();
    values.set("malformed", {
      version: 1,
      kind: "managed-thread",
    } as unknown as StoredCodexManagedThread);

    await expect(createCodexManagedThreadStore(state).snapshot()).resolves.toEqual(new Map());
  });

  it("derives the catalog home from nested rollout paths", () => {
    expect(codexHomeFromRolloutPath("/tmp/codex/sessions/2026/08/rollout.jsonl")).toBe(
      "/tmp/codex",
    );
    expect(codexHomeFromRolloutPath("/tmp/codex/not-sessions/rollout.jsonl")).toBeUndefined();
  });
});
