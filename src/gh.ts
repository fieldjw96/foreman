import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Ticket = {
  number: number;
  title: string;
  labels: string[];
  repo: string;
  /** Issue numbers that must close before this one may start. */
  blockedBy: number[];
};

/**
 * Every gh call goes through here as an argv array, never a command string. The old
 * dispatcher built shell strings and lost arguments to PowerShell's quote splitting often
 * enough that it is worth making the unsafe form impossible rather than discouraged.
 */
export async function gh(args: string[]): Promise<string> {
  const { stdout } = await run("gh", args, {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function listTickets(repo: string): Promise<Ticket[]> {
  const out = await gh([
    "issue", "list",
    "--repo", repo,
    "--state", "open",
    "--limit", "200",
    "--json", "number,title,labels,blockedBy",
  ]);
  const raw = JSON.parse(out) as {
    number: number;
    title: string;
    labels: { name: string }[];
    blockedBy?: { nodes: { number: number; state: string }[] };
  }[];
  return raw.map((t) => ({
    number: t.number,
    title: t.title,
    labels: t.labels.map((l) => l.name),
    repo,
    // Only open blockers count. A closed one has already been satisfied.
    blockedBy: (t.blockedBy?.nodes ?? []).filter((n) => n.state === "OPEN").map((n) => n.number),
  }));
}

export async function setStatus(repo: string, issue: number, add: string, remove: string[]): Promise<void> {
  const args = ["issue", "edit", String(issue), "--repo", repo, "--add-label", add];
  for (const label of remove.filter((l) => l !== add)) {
    args.push("--remove-label", label);
  }
  await gh(args);
}

export async function comment(repo: string, issue: number, body: string): Promise<void> {
  await gh(["issue", "comment", String(issue), "--repo", repo, "--body", body]);
}

/**
 * The success test for a Run: an open pull request on its branch, touched since the Run
 * began.
 *
 * Both halves of that matter. `--state all` would match a pull request closed weeks ago,
 * and a Ticket that has been run before usually has exactly that, so a Run that did nothing
 * at all would be recorded as a success. The freshness check catches the same trap one
 * layer down: a stale *open* pull request from a previous attempt. Comparing against
 * `updatedAt` rather than `createdAt` keeps the case where a Run pushes new commits to a
 * pull request that already existed, which is a real success and not a new pull request.
 */
export async function findPullRequest(
  repo: string,
  branch: string,
  since?: Date,
): Promise<number | null> {
  const out = await gh([
    "pr", "list",
    "--repo", repo,
    "--head", branch,
    "--state", "open",
    "--limit", "10",
    "--json", "number,updatedAt",
  ]);
  const rows = JSON.parse(out) as { number: number; updatedAt: string }[];
  return pickFreshPullRequest(rows, since);
}

/** Split out from the gh call so the rule itself can be tested without the network. */
export function pickFreshPullRequest(
  rows: { number: number; updatedAt: string }[],
  since?: Date,
): number | null {
  const fresh = since
    ? rows.filter((r) => new Date(r.updatedAt).getTime() >= since.getTime())
    : rows;
  // Highest number is the most recently opened.
  return fresh.sort((a, b) => b.number - a.number)[0]?.number ?? null;
}

/** How many times a Run has already failed on this Ticket, counted from GitHub, not locally. */
export async function countFailedAttempts(repo: string, issue: number, marker: string): Promise<number> {
  const out = await gh([
    "issue", "view", String(issue),
    "--repo", repo,
    "--json", "comments",
  ]);
  const { comments } = JSON.parse(out) as { comments: { body: string }[] };
  return comments.filter((c) => c.body.includes(marker)).length;
}
