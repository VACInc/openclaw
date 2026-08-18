import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { StoredCodexManagedThread } from "./managed-thread-store.js";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

describe("lazy Codex binding store ownership listing", () => {
  it("lists active OpenClaw threads while preserving adopted native sources", async () => {
    const bindingState = createCodexTestBindingStateStore();
    const entries = vi.spyOn(bindingState, "entries");
    const managedState: Pick<
      PluginStateSyncKeyedStore<StoredCodexManagedThread>,
      "entries" | "registerIfAbsent"
    > = {
      entries: () => [],
      registerIfAbsent: () => false,
    };
    const store = createLazyCodexAppServerBindingStore(bindingState, managedState);
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
    await store.mutate(
      { kind: "session", agentId: "main", sessionId: "descendant" },
      {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: "thread-descendant",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-native",
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          model: "gpt-5.4-codex",
          modelProvider: "openai",
        },
      },
    );
    await store.mutate(
      { kind: "session", agentId: "main", sessionId: "cleared" },
      {
        kind: "set",
        if: { kind: "absent" },
        binding: { threadId: "thread-cleared", cwd: "/repo" },
      },
    );
    await store.mutate(
      { kind: "session", agentId: "main", sessionId: "cleared" },
      { kind: "clear", threadId: "thread-cleared" },
    );

    await expect(store.listActiveOrdinaryThreadIds?.()).resolves.toEqual(
      new Set(["thread-managed", "thread-descendant"]),
    );
    await store.listActiveOrdinaryThreadIds?.();
    expect(entries).toHaveBeenCalledOnce();

    await store.mutate(
      { kind: "session", agentId: "main", sessionId: "ordinary" },
      { kind: "clear", threadId: "thread-managed" },
    );
    await expect(store.listActiveOrdinaryThreadIds?.()).resolves.toEqual(
      new Set(["thread-descendant"]),
    );
    expect(entries).toHaveBeenCalledTimes(2);
  });
});
