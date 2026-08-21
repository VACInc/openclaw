import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeManagedSessionStore,
  type StoredClaudeManagedSession,
} from "./managed-session-store.js";

const BACKFILL_KEY = "migration:managed-provenance-backfill:v3";

function createState() {
  const values = new Map<string, StoredClaudeManagedSession>();
  const entries = vi.fn(() => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })));
  const registerIfAbsent = vi.fn((key: string, value: StoredClaudeManagedSession) => {
    if (values.has(key)) {
      return false;
    }
    values.set(key, value);
    return true;
  });
  return {
    state: { entries, registerIfAbsent } satisfies Pick<
      PluginStateSyncKeyedStore<StoredClaudeManagedSession>,
      "entries" | "registerIfAbsent"
    >,
    values,
  };
}

describe("Claude managed session store", () => {
  it("keeps durable ownership host-scoped and backfills it once", async () => {
    const fixture = createState();
    const store = createClaudeManagedSessionStore(fixture.state);
    const candidates = vi
      .fn()
      .mockResolvedValueOnce([{ hostId: "gateway:local", sessionId: "legacy" }])
      .mockResolvedValueOnce([{ hostId: "gateway:local", sessionId: "ignored" }]);

    await store.mark({ hostId: "node:a", sessionId: "shared" });
    await store.mark({ hostId: "node:b", sessionId: "shared" });
    await store.snapshot(candidates);
    await store.snapshot(candidates);

    expect(candidates).toHaveBeenCalledTimes(1);
    expect(fixture.values.has(BACKFILL_KEY)).toBe(true);
    await expect(store.snapshot()).resolves.toEqual(
      new Map([
        ["node:a", new Set(["shared"])],
        ["node:b", new Set(["shared"])],
        ["gateway:local", new Set(["legacy"])],
      ]),
    );
  });

  it("fails open when durable bookkeeping is unavailable", async () => {
    const fixture = createState();
    fixture.state.registerIfAbsent = vi.fn(() => {
      throw new Error("state unavailable");
    });

    await expect(
      createClaudeManagedSessionStore(fixture.state).mark({
        hostId: "gateway:local",
        sessionId: "new-session",
      }),
    ).resolves.toBe(false);
  });
});
