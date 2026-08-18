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
  it("keeps host-scoped ownership idempotent", async () => {
    const fixture = createState();
    const store = createClaudeManagedSessionStore(fixture.state);
    await store.mark({ hostId: " gateway:local ", sessionId: " shared " });
    await store.mark({ hostId: "gateway:local", sessionId: "shared" });
    await store.mark({ hostId: "node:a", sessionId: "shared" });
    await expect(store.snapshot()).resolves.toEqual(
      new Map([
        ["gateway:local", new Set(["shared"])],
        ["node:a", new Set(["shared"])],
      ]),
    );
    await expect(store.mark({ hostId: " ", sessionId: "shared" })).resolves.toBe(false);
  });

  it("backfills managed provenance once before recording completion", async () => {
    const fixture = createState();
    const store = createClaudeManagedSessionStore(fixture.state);
    const candidates = vi
      .fn()
      .mockResolvedValueOnce([{ hostId: "gateway:local", sessionId: "legacy" }])
      .mockResolvedValueOnce([{ hostId: "gateway:local", sessionId: "ignored-later" }]);
    await store.snapshot(candidates);
    await store.snapshot(candidates);
    expect(fixture.values.has(BACKFILL_KEY)).toBe(true);
    expect(candidates).toHaveBeenCalledTimes(1);
    await expect(store.snapshot()).resolves.toEqual(
      new Map([["gateway:local", new Set(["legacy"])]]),
    );
  });

  it("retries migration when durable ownership registration fails", async () => {
    const fixture = createState();
    fixture.state.registerIfAbsent = vi.fn(() => {
      throw new Error("plugin state full");
    });
    const store = createClaudeManagedSessionStore(fixture.state);
    const candidates = vi.fn(async () => [{ hostId: "gateway:local", sessionId: "legacy" }]);

    await store.snapshot(candidates);
    await store.snapshot(candidates);

    expect(candidates).toHaveBeenCalledTimes(2);
    expect(fixture.values.has(BACKFILL_KEY)).toBe(false);
  });

  it("ignores malformed stored rows and invalid backfill markers", async () => {
    const fixture = createState();
    fixture.values.set("malformed-session", {
      version: 1,
      kind: "managed-session",
      hostId: "",
      sessionId: "ignored",
    } as StoredClaudeManagedSession);
    fixture.values.set(BACKFILL_KEY, {
      version: 3,
      kind: "wrong-marker",
    } as unknown as StoredClaudeManagedSession);
    const candidates = vi.fn(async () => [{ hostId: "gateway:local", sessionId: "legacy" }]);

    await expect(
      createClaudeManagedSessionStore(fixture.state).snapshot(candidates),
    ).resolves.toEqual(new Map([["gateway:local", new Set(["legacy"])]]));
    expect(candidates).toHaveBeenCalledTimes(1);
  });
});
