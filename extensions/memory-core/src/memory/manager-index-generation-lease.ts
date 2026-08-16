// Memory Core coordinates published-index readers with atomic shadow publication.
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  tryAcquireMemorySqliteLease,
  type MemorySqliteLeaseHandle,
} from "./manager-sqlite-lease.js";
type Waiter = {
  kind: "read" | "write";
  resolve: (release: () => void) => void;
};

type GenerationLeaseState = {
  readers: number;
  writer: boolean;
  queue: Waiter[];
};

const states = new Map<string, GenerationLeaseState>();
const CROSS_PROCESS_RETRY_DELAY_MS = 25;

async function acquireCrossProcessLease(
  databasePath: string,
  kind: Waiter["kind"],
): Promise<MemorySqliteLeaseHandle> {
  const location = `${databasePath}.generation-lock.sqlite`;
  const mode = kind === "read" ? "shared" : "exclusive";
  while (true) {
    const lease = tryAcquireMemorySqliteLease(location, mode);
    if (lease) {
      return lease;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CROSS_PROCESS_RETRY_DELAY_MS);
    });
  }
}

function stateFor(key: string): GenerationLeaseState {
  const existing = states.get(key);
  if (existing) {
    return existing;
  }
  const created = { readers: 0, writer: false, queue: [] };
  states.set(key, created);
  return created;
}

function drain(key: string, state: GenerationLeaseState): void {
  if (state.writer) {
    return;
  }
  if (state.readers > 0) {
    // Readers already in the current generation may admit more readers until a
    // writer reaches the queue head. Readers behind that writer wait for the next generation.
    while (state.queue[0]?.kind === "read") {
      const reader = state.queue.shift()!;
      state.readers += 1;
      reader.resolve(() => {
        state.readers -= 1;
        drain(key, state);
      });
    }
    return;
  }
  const first = state.queue.shift();
  if (!first) {
    states.delete(key);
    return;
  }
  if (first.kind === "write") {
    state.writer = true;
    first.resolve(() => {
      state.writer = false;
      drain(key, state);
    });
    return;
  }
  const readers = [first];
  while (state.queue[0]?.kind === "read") {
    readers.push(state.queue.shift()!);
  }
  state.readers = readers.length;
  for (const reader of readers) {
    reader.resolve(() => {
      state.readers -= 1;
      drain(key, state);
    });
  }
}

async function acquireLocal(key: string, kind: Waiter["kind"]): Promise<() => void> {
  const state = stateFor(key);
  return await new Promise<() => void>((resolve) => {
    state.queue.push({ kind, resolve });
    drain(key, state);
  });
}

async function acquire(databasePath: string, kind: Waiter["kind"]): Promise<() => void> {
  const key = resolveUserPath(databasePath);
  const releaseLocal = await acquireLocal(key, kind);
  let crossProcess: MemorySqliteLeaseHandle;
  try {
    crossProcess = await acquireCrossProcessLease(key, kind);
  } catch (err) {
    releaseLocal();
    throw err;
  }
  return () => {
    try {
      crossProcess.release();
    } finally {
      releaseLocal();
    }
  };
}

async function withLease<T>(key: string, kind: Waiter["kind"], run: () => Promise<T>): Promise<T> {
  const release = await acquire(key, kind);
  try {
    return await run();
  } finally {
    release();
  }
}

export async function acquireMemoryIndexReadGeneration(databasePath: string): Promise<() => void> {
  return await acquire(databasePath, "read");
}

export async function withMemoryIndexPublishGeneration<T>(
  databasePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return await withLease(databasePath, "write", run);
}
