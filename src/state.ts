import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

export type LiveRun = {
  repo: string;
  issue: number;
  pid: number;
  branch: string;
  worktree: string;
  logFile: string;
  startedAt: string;
};

export type State = { runs: LiveRun[] };

const EMPTY: State = { runs: [] };

/**
 * Local, disposable, and deliberately outside OneDrive: it holds process ids, which mean
 * nothing on the other laptop. Losing this file costs one reconciliation pass, never a
 * Ticket, because the Ticket's own label is what actually records its state.
 */
export function statePath(worktreeRoot: string): string {
  return join(worktreeRoot, "foreman-state.json");
}

export function readState(path: string): State {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as State;
    return Array.isArray(parsed.runs) ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Written through a temp file so a crash mid-write cannot leave unparseable JSON behind. */
export function writeState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

/** True when the process is gone. signal 0 tests for existence without touching it. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function ageMinutes(startedAt: string, now: Date = new Date()): number {
  return (now.getTime() - new Date(startedAt).getTime()) / 60_000;
}
