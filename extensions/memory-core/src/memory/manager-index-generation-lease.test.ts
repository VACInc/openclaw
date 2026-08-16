// Memory Core tests published-index read and publication ordering.
import { describe, expect, it, vi } from "vitest";
import {
  acquireMemoryIndexReadGeneration,
  withMemoryIndexPublishGeneration,
} from "./manager-index-generation-lease.js";

async function withReadGeneration<T>(key: string, run: () => Promise<T>): Promise<T> {
  const release = await acquireMemoryIndexReadGeneration(key);
  try {
    return await run();
  } finally {
    release();
  }
}

describe("memory index generation lease", () => {
  it("admits another reader into the active generation when no writer is queued", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];

    const firstReader = withReadGeneration("shared-reader-generation", async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));

    const nextReader = withReadGeneration("shared-reader-generation", async () => {
      events.push("next-reader");
    });
    await nextReader;
    expect(events).toEqual(["first-reader", "next-reader"]);

    releaseFirstReader();
    await firstReader;
  });

  it("lets readers continue while publication waits for the active generation", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];

    const firstReader = withReadGeneration("reader-before-publish", async () => {
      events.push("first-reader-start");
      await firstReaderGate;
      events.push("first-reader-end");
    });
    await vi.waitFor(() => expect(events).toContain("first-reader-start"));

    const publish = withMemoryIndexPublishGeneration("reader-before-publish", async () => {
      events.push("publish");
    });
    await Promise.resolve();
    expect(events).not.toContain("publish");

    releaseFirstReader();
    await Promise.all([firstReader, publish]);
    expect(events).toEqual(["first-reader-start", "first-reader-end", "publish"]);
  });

  it("does not admit a new generation reader ahead of queued publication", async () => {
    let releaseFirstReader = () => {};
    const firstReaderGate = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    const events: string[] = [];

    const firstReader = withReadGeneration("publish-before-reader", async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));
    const publish = withMemoryIndexPublishGeneration("publish-before-reader", async () => {
      events.push("publish");
    });
    const nextReader = withReadGeneration("publish-before-reader", async () => {
      events.push("next-reader");
    });

    releaseFirstReader();
    await Promise.all([firstReader, publish, nextReader]);
    expect(events).toEqual(["first-reader", "publish", "next-reader"]);
  });
});
