import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type UpdateResult =
  | { changed: false; reason: string }
  | { changed: true; from: string; to: string };

/**
 * Brings foreman's own clone up to date with `main` before a tick reads any of it.
 *
 * Without this, merging a change to foreman does nothing until somebody remembers to pull on
 * the server laptop, and nothing anywhere says so. That happened the first time: the fix-Run
 * feature was merged, the scheduled task kept running the previous code, and the only symptom
 * was pull requests quietly not being picked up.
 *
 * Deliberately narrower than the archived harness's self-update, which pulled and could
 * therefore rewrite the running tree from a Run's own commits mid-flight:
 *
 * - **Fast-forward only.** Never a merge, never a rebase. If the clone has diverged, that is
 *   a human's problem and the tick carries on with the code it already has rather than
 *   resolving anything unattended.
 * - **Refuses to touch a dirty tree.** Local edits are someone working, and discarding them
 *   to pick up a config change is a bad trade.
 * - **Never fatal.** A failed update leaves the previous version running, which is a working
 *   supervisor one commit behind rather than no supervisor at all.
 */
export async function selfUpdate(repoRoot: string): Promise<UpdateResult> {
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await run("git", ["-C", repoRoot, ...args], { windowsHide: true });
    return stdout.trim();
  };

  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== "main") {
      return { changed: false, reason: `on ${branch}, not main` };
    }

    const dirty = await git(["status", "--porcelain"]);
    if (dirty !== "") {
      return { changed: false, reason: "working tree has local changes" };
    }

    const before = await git(["rev-parse", "--short", "HEAD"]);
    await git(["fetch", "origin", "main", "--quiet"]);
    const target = await git(["rev-parse", "--short", "origin/main"]);
    if (before === target) {
      return { changed: false, reason: "already current" };
    }

    // --ff-only: if main and the clone have diverged this fails rather than merging, and the
    // catch below leaves the running version alone.
    await git(["merge", "--ff-only", "origin/main"]);
    return { changed: true, from: before, to: target };
  } catch (error) {
    return { changed: false, reason: (error as Error).message.split("\n")[0] ?? "update failed" };
  }
}
