import fs from "node:fs/promises";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread } from "./app-server/protocol.js";

const MAX_SESSION_META_BYTES = 1024 * 1024;
const SESSION_META_READ_CHUNK_BYTES = 64 * 1024;
const MAX_PROVENANCE_CACHE_ENTRIES = 20_000;

const provenanceByPath = new Map<string, boolean>();

function cacheProvenance(path: string, value: boolean): void {
  provenanceByPath.delete(path);
  provenanceByPath.set(path, value);
  while (provenanceByPath.size > MAX_PROVENANCE_CACHE_ENTRIES) {
    const oldest = provenanceByPath.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    provenanceByPath.delete(oldest);
  }
}

/** Undefined means the metadata line is not durable enough to cache yet. */
async function readOpenClawOriginator(
  path: string,
  threadId: string,
): Promise<boolean | undefined> {
  const handle = await fs.open(path, "r").catch(() => undefined);
  if (!handle) {
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    let line: string | undefined;
    while (bytesReadTotal < MAX_SESSION_META_BYTES) {
      const buffer = Buffer.allocUnsafe(
        Math.min(SESSION_META_READ_CHUNK_BYTES, MAX_SESSION_META_BYTES - bytesReadTotal),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytesReadTotal);
      if (bytesRead === 0) {
        break;
      }
      bytesReadTotal += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
      if (newline >= 0) {
        line = Buffer.concat(chunks).toString("utf8");
        break;
      }
    }
    if (!line) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      return false;
    }
    const payload = parsed.payload;
    const recordedId = payload.id ?? payload.session_id;
    return recordedId === threadId && payload.originator === "openclaw";
  } finally {
    await handle.close();
  }
}

/**
 * Codex 0.147 reports OpenClaw app-server rollouts as `vscode`, so the rollout's
 * immutable session metadata is the authoritative historical provenance.
 */
export async function isOpenClawManagedCodexThread(thread: CodexThread): Promise<boolean> {
  const path = typeof thread.path === "string" ? thread.path.trim() : "";
  if (!path) {
    return false;
  }
  const cached = provenanceByPath.get(path);
  if (cached !== undefined) {
    return cached;
  }
  const managed = await readOpenClawOriginator(path, thread.id);
  // A missing or still-being-written rollout must not become a permanent false
  // negative. Newly created sessions are additionally covered by the durable
  // ownership store, while a completed metadata line can be cached safely.
  if (managed !== undefined) {
    cacheProvenance(path, managed);
  }
  return managed ?? false;
}
