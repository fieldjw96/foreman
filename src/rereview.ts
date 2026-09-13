import { gh } from "./gh.ts";
import type { OpenPullRequest } from "./pulls.ts";

/** The exact body the review workflow matches on. It tests the comment *starts* with this. */
export const REVIEW_COMMAND = "/review";

/**
 * Whether foreman should ask for a fresh review on a pull request it is otherwise waiting on.
 *
 * Two conditions, both necessary:
 *
 * 1. **The code has moved past the verdict.** A standing rejection against the current code is
 *    a fix Run's job, not a re-review's.
 * 2. **Nobody has asked since that code landed.** Without this the supervisor would ask again
 *    every five minutes while the review it already requested was still running.
 *
 * A pull request with no verdict at all is deliberately not covered. The `pull_request`
 * trigger reviews those on open, and asking again would double every first review. The case
 * where that initial review never posts a verdict — the reviewer exhausting its turn budget,
 * as on rolodeck-ai#117 — still ends with a human, and pretending otherwise would mean
 * inventing a timeout to guess at.
 */
export function needsReviewRequest(
  pr: OpenPullRequest,
  lastRequestAt: string | null,
): boolean {
  if (pr.gateVerdictAt === null) return false;

  const committedAt = new Date(pr.lastCommitAt).getTime();
  const verdictAt = new Date(pr.gateVerdictAt).getTime();
  if (committedAt <= verdictAt) return false;

  if (lastRequestAt === null) return true;
  return committedAt > new Date(lastRequestAt).getTime();
}

/**
 * When someone last asked for a review on this pull request. Matches the same way the
 * workflow does, on the comment *starting* with the command, so a comment that merely
 * mentions it in prose is correctly not counted as having asked.
 */
export async function lastReviewRequestAt(repo: string, pr: number): Promise<string | null> {
  const out = await gh(["pr", "view", String(pr), "--repo", repo, "--json", "comments"]);
  const { comments } = JSON.parse(out) as {
    comments: { body: string; createdAt: string }[] | null;
  };
  const requests = (comments ?? []).filter((c) => c.body.startsWith(REVIEW_COMMAND));
  return requests[requests.length - 1]?.createdAt ?? null;
}

/**
 * Asks for a review.
 *
 * The body is exactly the command and nothing else, because the workflow matches on the
 * comment starting with it. `--body-file` with a temp file would be equivalent; what must not
 * happen is the value reaching a Windows shell as a bare argument beginning with "/", which
 * Git Bash rewrites into a path: rolodeck-ai#127 sat for an hour after a fix Run posted
 * "C:/Program Files/Git/review" and waited for a review nobody had requested. Passing argv
 * through execFile rather than a shell is what makes that impossible here.
 */
export async function requestReview(repo: string, pr: number): Promise<void> {
  await gh(["pr", "comment", String(pr), "--repo", repo, "--body", REVIEW_COMMAND]);
}

/**
 * Whether the branch merges cleanly but is out of date with its base.
 *
 * The ruleset requires a branch to be current before it can merge, which is the rule that
 * catches the stale-green case: checks describe the world when they ran. GitHub is supposed
 * to update the branch itself once auto-merge is armed and `allow_update_branch` is on, and
 * on this repo it did not: three pull requests sat BEHIND for an hour with nothing moving.
 *
 * Updating is a mechanical API call, not work for an agent, so the supervisor does it for the
 * same reason it asks for reviews rather than delegating that to a Run.
 */
export function needsBranchUpdate(mergeState: string): boolean {
  return mergeState.toUpperCase() === "BEHIND";
}

/**
 * Brings a pull request's branch up to date with its base.
 *
 * This lands a merge commit on the branch, which under a ruleset carrying
 * `dismiss_stale_reviews_on_push` dismisses the Gate's approval. That is correct rather than
 * unfortunate: the approval described different code. The next tick sees a commit newer than
 * the verdict and asks for a fresh review, so the cycle closes on its own.
 */
export async function updateBranch(repo: string, pr: number): Promise<void> {
  await gh(["pr", "update-branch", String(pr), "--repo", repo]);
}
