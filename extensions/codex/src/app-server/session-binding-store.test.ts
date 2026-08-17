import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { StoredCodexManagedThread } from "./managed-thread-store.js";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

function createManagedStateStore() {
  const values = new Map<string, StoredCodexManagedThread>();
  const entries = vi.fn(() => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })));
  const registerIfAbsent = vi.fn((key: string, value: StoredCodexManagedThread) => {
    if (values.has(key)) {
      return false;
    }
    values.set(key, value);
    return true;
  });
  return {
    state: { entries, registerIfAbsent } satisfies Pick<
      PluginStateSyncKeyedStore<StoredCodexManagedThread>,
      "entries" | "registerIfAbsent"
    >,
    values,
    registerIfAbsent,
  };
}

describe("lazy Codex binding store managed-thread backfill", () => {
  it("backfills active backing threads once while preserving adopted source threads", async () => {
    const bindingState = createCodexTestBindingStateStore();
    const managed = createManagedStateStore();
    const store = createLazyCodexAppServerBindingStore(bindingState, managed.state);
    await store.mutate(
      { kind: "session", agentId: "main", sessionId: "ordinary" },
      {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: "thread-managed",
          cwd: "/repo",
          rolloutPath: "/tmp/codex-a/sessions/2026/08/managed.jsonl",
        },
      },
    );
    await store.mutate(
      { kind: "session", agentId: "main", sessionId: "adopted" },
      {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: "thread-native",
          cwd: "/repo",
          rolloutPath: "/tmp/codex-a/sessions/2026/08/native.jsonl",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-native",
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          model: "gpt-5.4-codex",
          modelProvider: "openai",
        },
      },
    );

    const first = await store.managedThreads?.snapshot();
    const writesAfterFirstSnapshot = managed.registerIfAbsent.mock.calls.length;
    const second = await store.managedThreads?.snapshot();

    expect(Array.from(first!.values()).flatMap((ids) => Array.from(ids))).toEqual([
      "thread-managed",
    ]);
    expect(second).toEqual(first);
    expect(managed.registerIfAbsent).toHaveBeenCalledTimes(writesAfterFirstSnapshot);
    expect([...managed.values.values()]).toContainEqual({
      version: 1,
      kind: "binding-backfill-complete",
    });
  });
});
