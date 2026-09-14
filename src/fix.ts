import type { OpenPullRequest } from "./pulls.ts";
import type { LiveRun } from "./state.ts";

export type PullRequestState = "needs-fix" | "waiting" | "ready-to-merge";

/**
 * The check the review Gate posts for itself. Named here because it is the one check whose
 * failure says nothing about the code under it.
 */
export const GATE_CHECK = "review";

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

  /**
   * A conflict outranks everything. A pull request that no longer merges cannot land however
   * green its checks are or however warmly the Gate approved it, so it needs a Run whatever
   * else is true of it.
   *
   * This is the failure that killed PRs #56 and #59 under the archived harness: they sat
   * approved while other work merged beneath them, went unmergeable, and were eventually
   * closed rather than finished. Nothing there ever noticed, because nothing was looking at
   * mergeability.
   *
   * UNKNOWN is GitHub still computing, and is never read as either answer.
   */
  if (pr.mergeable === "CONFLICTING") return "needs-fix";

  // A red check is always about the current head: GitHub attaches it to the commit.
  /**
   * The Gate's own check is not a statement about the code. It goes red when the reviewer
   * itself failed to finish, and exhausting its turn budget on a large diff is how that
   * actually happens. The remedy is another review, not a Run sent at code nobody has found
   * fault with.
   *
   * rolodeck-ai#132 was APPROVED and BLOCKED at once for exactly this reason, and the
   * supervisor then spent that Ticket's whole fix budget rewriting code that was already
   * right, until it gave up and asked for a human. Three Runs and a stalled Ticket because a
   * reviewer ran out of room to read.
   */
  const codeChecks = pr.failedChecks.filter((name) => name !== GATE_CHECK);
  if (codeChecks.length > 0) return "needs-fix";
  if (pr.failedChecks.includes(GATE_CHECK)) return "waiting";

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
