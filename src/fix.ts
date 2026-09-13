import type { OpenPullRequest } from "./pulls.ts";
import type { LiveRun } from "./state.ts";

export type PullRequestState = "needs-fix" | "waiting" | "ready-to-merge";

/**
 * Whether a Run should be sent back to a pull request.
 *
 * The whole rule is one comparison: **is the complaint newer than the code?** A rejection or
 * a red check that predates the branch's latest commit has already been answered, and the
 * pull request is waiting on a re-review rather than on a fix.
 *
 * This is deliberately not the Bounce the archived harness had. That kept two separate
 * counters, `maxBounces` and `maxBouncedRetries`, and re-ran Tickets whose cause had
 * "plausibly changed" — which in practice meant re-running work against a cause that had not
 * changed at all. Two pull requests burned their whole budget that way without getting
 * closer, and were closed unmerged. A timestamp cannot drift the way a counter can.
 */
export function classifyPullRequest(
  pr: OpenPullRequest,
  now: Date = new Date(),
): PullRequestState {
  const committedAt = new Date(pr.lastCommitAt).getTime();

  // A red check is always about the current head: GitHub attaches it to the commit.
  if (pr.failedChecks.length > 0) return "needs-fix";

  if (pr.gateVerdict === "CHANGES_REQUESTED") {
    const verdictAt = pr.gateVerdictAt === null ? 0 : new Date(pr.gateVerdictAt).getTime();
    // Strictly newer. A verdict landing in the same second as a commit is treated as
    // already answered, because the alternative is a Run that fixes what is already fixed.
    return verdictAt > committedAt ? "needs-fix" : "waiting";
  }

  if (pr.gateVerdict === "APPROVED") {
    const verdictAt = pr.gateVerdictAt === null ? 0 : new Date(pr.gateVerdictAt).getTime();
    // An approval older than the code it approves is not an approval of this code.
    return verdictAt >= committedAt ? "ready-to-merge" : "waiting";
  }

  // No verdict yet. Never treat silence as either approval or rejection: the review may
  // still be running, and the archived harness proved that a reviewer can fail for reasons
  // that have nothing to do with the code, such as exhausting its turn budget.
  void now;
  return "waiting";
}

/**
 * The pull requests to send a Run back to, in the order they should be taken. Ones already
 * being worked are excluded by number, the same way Tickets are, so a state file that has
 * drifted cannot start a second Run against one branch.
 */
export function chooseFixes(
  pulls: OpenPullRequest[],
  live: LiveRun[],
  slots: number,
  now: Date = new Date(),
): OpenPullRequest[] {
  const busy = new Set(live.map((r) => `${r.repo}#${r.issue}`));
  return pulls
    .filter((pr) => classifyPullRequest(pr, now) === "needs-fix")
    .filter((pr) => pr.issue !== null && !busy.has(`${pr.repo}#${pr.issue}`))
    .sort((a, b) => a.number - b.number)
    .slice(0, slots);
}
