import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { rmSync } from "node:fs";

const run = promisify(execFile);

export function branchName(issue: number): string {
  return `ticket/${issue}`;
}

/**
 * Worktrees live on local disk, never inside OneDrive. A Run that built inside the synced
 * clone would push node_modules and .next through sync to the other laptop, and a
 * `git checkout` in the canonical clone changes what the other machine sees mid-edit.
 */
export function worktreePath(worktreeRoot: string, repo: string, issue: number): string {
  return join(worktreeRoot, repo.split("/")[1] ?? repo, String(issue));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function createWorktree(
  clonePath: string,
  worktree: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  await git(clonePath, ["fetch", "origin", baseBranch, "--quiet"]);
  await removeWorktree(clonePath, worktree).catch(() => {});
  await git(clonePath, ["worktree", "add", "-B", branch, worktree, `origin/${baseBranch}`]);
}

export async function removeWorktree(clonePath: string, worktree: string): Promise<void> {
  try {
    await git(clonePath, ["worktree", "remove", worktree, "--force"]);
  } catch {
    // The worktree may already be gone, or its directory deleted underneath git. Prune the
    // administrative record either way, then make sure the directory itself is gone.
    await git(clonePath, ["worktree", "prune"]).catch(() => {});
    rmSync(worktree, { recursive: true, force: true });
  }
}
