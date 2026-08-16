// Memory Core tests published-index read and publication ordering.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireMemoryIndexReadGeneration,
  withMemoryIndexPublishGeneration,
} from "./manager-index-generation-lease.js";

const leaseChildSource = String.raw`
  import { once } from "node:events";
  import { DatabaseSync } from "node:sqlite";

  const [, mode, databasePath] = process.argv;
  const database = new DatabaseSync(databasePath + ".generation-lock.sqlite");
  database.exec("PRAGMA busy_timeout = 0");
  try {
    if (mode === "read") {
      database.exec("BEGIN");
      database.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
      process.stdout.write("acquired\n");
    } else {
      let reportedContention = false;
      while (true) {
        try {
          database.exec("BEGIN EXCLUSIVE");
          process.stdout.write("acquired\n");
          break;
        } catch (error) {
          if (!/SQLITE_(?:BUSY|LOCKED)|database is locked/iu.test(String(error))) throw error;
          if (!reportedContention) {
            reportedContention = true;
            process.stdout.write("contended\n");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }
    process.stdin.resume();
    await once(process.stdin, "end");
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
`;

function spawnLeaseFixture(
  mode: "read" | "write",
  databasePath: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--input-type=module", "--eval", leaseChildSource, mode, databasePath],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

async function readChildLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  const [chunk] = await once(child.stdout, "data");
  return String(chunk).trim();
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.stdin.end();
  await once(child, "exit");
}

let fixtureRoot = "";

beforeEach(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-generation-"));
});

afterEach(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function leasePath(name: string): string {
  return path.join(fixtureRoot, `${name}.sqlite`);
}

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

    const generationPath = leasePath("shared-reader-generation");
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));

    const nextReader = withReadGeneration(generationPath, async () => {
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

    const generationPath = leasePath("reader-before-publish");
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader-start");
      await firstReaderGate;
      events.push("first-reader-end");
    });
    await vi.waitFor(() => expect(events).toContain("first-reader-start"));

    const publish = withMemoryIndexPublishGeneration(generationPath, async () => {
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

    const generationPath = leasePath("publish-before-reader");
    const firstReader = withReadGeneration(generationPath, async () => {
      events.push("first-reader");
      await firstReaderGate;
    });
    await vi.waitFor(() => expect(events).toContain("first-reader"));
    const publish = withMemoryIndexPublishGeneration(generationPath, async () => {
      events.push("publish");
    });
    const nextReader = withReadGeneration(generationPath, async () => {
      events.push("next-reader");
    });

    releaseFirstReader();
    await Promise.all([firstReader, publish, nextReader]);
    expect(events).toEqual(["first-reader", "publish", "next-reader"]);
  });

  it("keeps another process from publishing during an active read generation", async () => {
    const databasePath = leasePath("reader-cross-process");
    const release = await acquireMemoryIndexReadGeneration(databasePath);
    let released = false;
    const child = spawnLeaseFixture("write", databasePath);
    try {
      expect(await readChildLine(child)).toBe("contended");
      const acquired = readChildLine(child);
      release();
      released = true;
      expect(await acquired).toBe("acquired");
    } finally {
      if (!released) {
        release();
      }
      await stopChild(child);
    }
  });

  it("waits for another process reader before publishing a new generation", async () => {
    const databasePath = leasePath("publisher-cross-process");
    const child = spawnLeaseFixture("read", databasePath);
    try {
      expect(await readChildLine(child)).toBe("acquired");
      const events: string[] = [];
      const publication = withMemoryIndexPublishGeneration(databasePath, async () => {
        events.push("published");
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(events).toEqual([]);

      await stopChild(child);
      await publication;
      expect(events).toEqual(["published"]);
    } finally {
      await stopChild(child);
    }
  });
});
