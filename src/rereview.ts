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
