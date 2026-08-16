// Memory Core plugin module serializes full memory reindex builds across processes.
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";

export type MemoryReindexLockHandle = {
  release: () => void;
};

const REINDEX_LOCK_WAIT_TIMEOUT_MS = 2_000;
const REINDEX_LOCK_RETRY_DELAY_MS = 25;

function resolveMemoryReindexLockPath(dbPath: string): string {
  return `${dbPath}.reindex-lock.sqlite`;
}

function isSqliteBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(message);
}

function openMemoryLockDatabase(lockPath: string): DatabaseSync {
  const lockDb = openNodeSqliteDatabase(lockPath);
  try {
    lockDb.exec("PRAGMA busy_timeout = 0");
    return lockDb;
  } catch (err) {
    try {
      lockDb.close();
    } catch {}
    throw err;
  }
}

function createMemoryReindexLockHandle(lockDb: DatabaseSync): MemoryReindexLockHandle {
  return {
    release: () => {
      let releaseError: unknown;
      try {
        lockDb.exec("ROLLBACK");
      } catch (err) {
        releaseError = err;
      }
      try {
        lockDb.close();
      } catch (err) {
        releaseError ??= err;
      }
      if (releaseError) {
        throw new Error("Failed to release memory reindex lock", { cause: releaseError });
      }
    },
  };
}

async function sleepAsync(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createMemoryReindexBusyError(lockPath: string): Error & { code: string } {
  return Object.assign(
    new Error(`Memory reindex lock is held at ${lockPath}; another reindex is active.`),
    { code: "SQLITE_BUSY" },
  );
}

/** Try to acquire the build lock without locking readers of the live agent database. */
export function tryAcquireMemoryReindexLock(dbPath: string): MemoryReindexLockHandle | undefined {
  const lockDb = openMemoryLockDatabase(resolveMemoryReindexLockPath(dbPath));
  try {
    lockDb.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    lockDb.close();
    if (isSqliteBusyError(err)) {
      return undefined;
    }
    throw err;
  }
  return createMemoryReindexLockHandle(lockDb);
}

/** Wait asynchronously for the exclusive build lock without blocking the Node event loop. */
export async function waitForMemoryReindexLock(dbPath: string): Promise<MemoryReindexLockHandle> {
  const lockPath = resolveMemoryReindexLockPath(dbPath);
  const deadline = Date.now() + REINDEX_LOCK_WAIT_TIMEOUT_MS;
  do {
    const lock = tryAcquireMemoryReindexLock(dbPath);
    if (lock) {
      return lock;
    }
    await sleepAsync(REINDEX_LOCK_RETRY_DELAY_MS);
  } while (Date.now() < deadline);

  const finalLock = tryAcquireMemoryReindexLock(dbPath);
  if (finalLock) {
    return finalLock;
  }
  throw createMemoryReindexBusyError(lockPath);
}
