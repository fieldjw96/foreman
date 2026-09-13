import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfUpdate } from "../src/selfupdate.ts";

/**
 * Against real git rather than a mock. The whole value of this module is that it does the
 * right thing with a diverged history, a dirty tree and a detached head, and a mock would
 * only assert that I called the commands I already decided to call.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRemoteAndClone(): { remote: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "foreman-su-"));
  const remote = join(root, "remote");
  const clone = join(root, "clone");

  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);

  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed]);
  git(seed, "config", "user.email", "t@example.com");
  git(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "one");
  git(seed, "push", "--quiet", "origin", "main");

  execFileSync("git", ["clone", "--quiet", remote, clone]);
  git(clone, "config", "user.email", "t@example.com");
  git(clone, "config", "user.name", "t");

  return { remote, clone };
}

/** Adds a commit to the remote's main, as merging a pull request would. */
function advanceRemote(remote: string): void {
  const work = mkdtempSync(join(tmpdir(), "foreman-adv-"));
  execFileSync("git", ["clone", "--quiet", remote, work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  writeFileSync(join(work, "b.txt"), "two\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "two");
  git(work, "push", "--quiet", "origin", "main");
}

describe("selfUpdate", () => {
  let remote: string;
  let clone: string;

  beforeEach(() => {
    ({ remote, clone } = makeRemoteAndClone());
  });

  it("reports no change when already current", async () => {
    const result = await selfUpdate(clone);
    expect(result.changed).toBe(false);
    expect(result.changed === false && result.reason).toBe("already current");
  });

  /**
   * The case this exists for. foreman's fix-Run feature was merged and the scheduled task
   * kept running the previous code, because nothing pulled and nothing said so.
   */
  it("fast-forwards when main has moved", async () => {
    advanceRemote(remote);
    const result = await selfUpdate(clone);
    expect(result.changed).toBe(true);
    expect(git(clone, "log", "--oneline", "-1")).toContain("two");
  });

  // Local edits are someone working. Discarding them to pick up a config change is a bad
  // trade, and the previous version still runs.
  it("refuses to touch a dirty working tree", async () => {
    writeFileSync(join(clone, "a.txt"), "edited\n");
    advanceRemote(remote);
    const result = await selfUpdate(clone);
    expect(result.changed).toBe(false);
    expect(result.changed === false && result.reason).toMatch(/local changes/);
    expect(git(clone, "log", "--oneline", "-1")).toContain("one");
  });

  /**
   * The case the first version of this got wrong. `git status --porcelain` counts untracked
   * files, so one stray .tmp or scratch script pinned foreman on old code for ever, and the
   * only symptom was work quietly not being picked up. An untracked file cannot conflict with
   * a fast-forward: git refuses on its own if the merge would overwrite one.
   */
  it("updates despite an untracked file, which cannot block a fast-forward", async () => {
    writeFileSync(join(clone, "stray.tmp"), "scratch");
    advanceRemote(remote);
    const result = await selfUpdate(clone);
    expect(result.changed).toBe(true);
    expect(git(clone, "log", "--oneline", "-1")).toContain("two");
  });

  it("does nothing when the clone is not on main", async () => {
    git(clone, "checkout", "--quiet", "-b", "some-branch");
    advanceRemote(remote);
    const result = await selfUpdate(clone);
    expect(result.changed).toBe(false);
    expect(result.changed === false && result.reason).toMatch(/not main/);
  });

  /**
   * Diverged is a human's problem. Resolving it unattended is exactly the kind of autonomy
   * that made the previous supervisor untrustworthy, so this fails and leaves the running
   * code alone rather than merging.
   */
  it("refuses to merge a diverged history, and keeps running the old code", async () => {
    writeFileSync(join(clone, "local.txt"), "mine\n");
    git(clone, "add", "-A");
    git(clone, "commit", "--quiet", "-m", "local only");
    advanceRemote(remote);

    const result = await selfUpdate(clone);
    expect(result.changed).toBe(false);
    expect(git(clone, "log", "--oneline", "-1")).toContain("local only");
  });

  // A supervisor one commit behind beats no supervisor at all.
  it("never throws, even pointed at something that is not a repo", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "foreman-none-"));
    const result = await selfUpdate(notARepo);
    expect(result.changed).toBe(false);
  });
});
