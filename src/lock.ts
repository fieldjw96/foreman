import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProcessAlive } from "./state.ts";

type LockFile = { pid: number; at: string };

export function lockPath(worktreeRoot: string): string {
  return join(worktreeRoot, "foreman.lock");
}

/**
 * Staleness is decided by whether the holder's process is alive, never by how long it has
 * held the lock. That distinction is the whole reason this is safe to have.
 *
 * The old harness locked on a timestamp with a two-hour staleness window, and could only
 * evaluate that window from inside a tick, which was precisely the thing that was stuck. A
 * dead pid is not a heuristic: if the holder is gone the lock is meaningless, whether it
 * was taken two seconds ago or last week.
 */
export function decideLock(existing: LockFile | null, selfPid: number): "take" | "blocked" {
  if (existing === null) return "take";
  if (existing.pid === selfPid) return "take";
  return isProcessAlive(existing.pid) ? "blocked" : "take";
}

export function readLock(path: string): LockFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LockFile;
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Returns the holder's pid when the lock could not be taken, so the caller can say who has
 * it rather than just refusing.
 */
export function acquireLock(path: string, selfPid = process.pid): { ok: true } | { ok: false; heldBy: number } {
  const existing = readLock(path);
  if (decideLock(existing, selfPid) === "blocked") {
    return { ok: false, heldBy: existing!.pid };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: selfPid, at: new Date().toISOString() }), "utf8");
  return { ok: true };
}

export function releaseLock(path: string, selfPid = process.pid): void {
  const existing = readLock(path);
  // Only ever release our own. Deleting another tick's lock is worse than leaking ours,
  // which the next tick reclaims for free once this process is gone.
  if (existing === null || existing.pid === selfPid) {
    rmSync(path, { force: true });
  }
}
