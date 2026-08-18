import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeManagedSessionStore,
  type StoredClaudeManagedSession,
} from "./managed-session-store.js";

const BACKFILL_KEY = "migration:binding-backfill:v1";

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
  it("keeps host-scoped ownership idempotent", async () => {
    const fixture = createState();
    const store = createClaudeManagedSessionStore(fixture.state);
    await store.mark({ hostId: "gateway:local", sessionId: "shared" });
    await store.mark({ hostId: "gateway:local", sessionId: "shared" });
    await store.mark({ hostId: "node:a", sessionId: "shared" });
    await expect(store.snapshot()).resolves.toEqual(
      new Map([
        ["gateway:local", new Set(["shared"])],
        ["node:a", new Set(["shared"])],
      ]),
    );
  });

  it("backfills legacy bindings once before recording completion", async () => {
    const fixture = createState();
    const store = createClaudeManagedSessionStore(fixture.state);
    await store.snapshot([{ hostId: "gateway:local", sessionId: "legacy" }]);
    await store.snapshot([{ hostId: "gateway:local", sessionId: "ignored-later" }]);
    expect(fixture.values.has(BACKFILL_KEY)).toBe(true);
    await expect(store.snapshot()).resolves.toEqual(
      new Map([["gateway:local", new Set(["legacy"])]]),
    );
  });
});
