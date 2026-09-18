import { gh } from "./gh.ts";
import type { OpenPullRequest } from "./pulls.ts";

/** The exact body the review workflow matches on. It tests the comment *starts* with this. */
export const REVIEW_COMMAND = "/review";

/**
 * Whether foreman should ask for a fresh review on a pull request it is otherwise waiting on.
 *
 * Either of two things means yes:
 *
 * 1. **There is no Gate check on the head commit**, so the pull request cannot merge whatever
 *    its verdict says. See `gateCheckOnHead` in `pulls.ts` for how a branch ends up like that.
 * 2. **The code has moved past the verdict.** A standing rejection against the current code is
 *    a fix Run's job, not a re-review's, but code newer than the verdict needs asking about.
 *
 * Both are guarded by the same condition: nobody has asked since that code landed. Without it
 * the supervisor would ask again every five minutes while the review it already requested was
 * still running. `lastReviewRequestAt` counts anyone's request, not only foreman's, so a fix
 * Run that asked for itself is not asked for twice.
 *
 * A pull request with no verdict at all is deliberately not covered by either. The
 * `pull_request` trigger reviews those on open, and asking again would double every first
 * review. The case where that initial review never posts a verdict — the reviewer exhausting
 * its turn budget, as on rolodeck-ai#117 — still ends with a human, and pretending otherwise
 * would mean inventing a timeout to guess at.
 */
export function needsReviewRequest(
  pr: OpenPullRequest,
  lastRequestAt: string | null,
): boolean {
  const asked = lastRequestAt === null ? 0 : new Date(lastRequestAt).getTime();

  // The Gate's own check failed, meaning the reviewer did not finish rather than that it
  // objected. Another review is the remedy. Keyed on when that failure concluded rather than
  // on the commit, because a review can fail without the branch moving at all, and the
  // commit-based guard below would then never ask again.
  if (pr.gateCheckFailedAt !== null) {
    return asked < new Date(pr.gateCheckFailedAt).getTime();
  }

  if (pr.gateVerdictAt === null) return false;

  const committedAt = new Date(pr.lastCommitAt).getTime();
  const verdictAt = new Date(pr.gateVerdictAt).getTime();

  // The ruleset requires a Gate check on *this* head, which comparing two timestamps cannot
  // answer. Updating a branch makes a new head and no review re-runs for it, so the check
  // stays on the commit it was posted for while the verdict, recorded later, still reads as
  // newer than the commit — and the rule below then says there is nothing to do. rolodeck-ai
  // #167 and #168 were both approved, green, mergeable and unmergeable at once, and neither
  // was noticed until a person went looking.
  if (!pr.gateCheckOnHead) {
    return lastRequestAt === null || committedAt > asked;
  }

  if (committedAt <= verdictAt) return false;

  if (lastRequestAt === null) return true;
  return committedAt > asked;
}

export type PullComment = { body: string; createdAt: string };

/**
 * A pull request's comments, fetched once so that everything read from them costs one call
 * rather than one each. Reading them is the only IO here; what they mean is decided by the
 * pure functions below, which is what makes those testable.
 */
export async function pullComments(repo: string, pr: number): Promise<PullComment[]> {
  const out = await gh(["pr", "view", String(pr), "--repo", repo, "--json", "comments"]);
  const { comments } = JSON.parse(out) as { comments: PullComment[] | null };
  return comments ?? [];
}

/**
 * When someone last asked for a review on this pull request. Matches the same way the
 * workflow does, on the comment *starting* with the command, so a comment that merely
 * mentions it in prose is correctly not counted as having asked.
 *
 * Deliberately not restricted to foreman's own comments: a fix Run that asked for itself has
 * asked, and asking again on top of it would double the review.
 */
export function lastReviewRequestAt(comments: PullComment[]): string | null {
  const requests = comments.filter((c) => c.body.startsWith(REVIEW_COMMAND));
  return requests[requests.length - 1]?.createdAt ?? null;
}

/** Marks a comment as foreman saying a pull request has stopped moving. */
export const STUCK_MARKER = "<!-- foreman:stuck -->";

/** When foreman last said this pull request was stuck, if it has. */
export function lastStuckReportAt(comments: PullComment[]): string | null {
  const reports = comments.filter((c) => c.body.includes(STUCK_MARKER));
  return reports[reports.length - 1]?.createdAt ?? null;
}

/**
 * How long a waiting pull request may go without anything happening before foreman says so.
 *
 * Not a tuning knob, and deliberately not in the config file: it is how long a wait stops
 * being normal, derived rather than guessed. The longest legitimate wait is a review behind a
 * full CI run, which the review workflow itself bounds at 20 minutes of waiting for other
 * checks plus the review, so under an hour end to end. Three hours is comfortably past that
 * and still inside a working morning, so nothing healthy trips it and nothing broken survives
 * unnoticed for a day.
 */
export const STUCK_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * Whether foreman should say out loud that a pull request has stopped moving.
 *
 * Every deadlock so far has lived in the `waiting` state, which means "something is expected
 * to happen" and has nothing checking that it ever does. rolodeck-ai#167 and #168 sat there
 * overnight: approved, green, mergeable and unmergeable, and found only because a person
 * asked whether anything needed attention.
 *
 * It reports rather than diagnoses, which is the whole design. A pull request blocked on a
 * code owner's approval looks identical from here to one blocked on a check nobody will ever
 * post, and GitHub does not cleanly separate them. Trying to tell them apart would mean a
 * fragile classifier; saying what is observed means a human decides. A pull request that has
 * been waiting on Jack for three hours is worth a nudge anyway, so that case is a feature
 * rather than a false positive.
 *
 * Quiet is measured from the newest thing that happened to the pull request, so a review
 * being asked for counts as progress and the clock restarts. Nothing is stored: every input
 * is already fetched, which is what keeps GitHub the only durable state.
 */
export function needsStuckReport(
  pr: OpenPullRequest,
  lastRequestAt: string | null,
  lastReportAt: string | null,
  hasLiveRun: boolean,
  now: Date,
): boolean {
  // A Run working on this pull request right now is exactly the thing that will move it, and
  // it may legitimately take most of an hour before it pushes anything.
  if (hasLiveRun) return false;

  const quietSince = quietSinceMs(pr, lastRequestAt);
  if (now.getTime() - quietSince < STUCK_AFTER_MS) return false;

  // Said once per stall, not once per tick. A report older than the last thing that happened
  // belongs to a previous stall, and this one has not been reported yet.
  if (lastReportAt === null) return true;
  return new Date(lastReportAt).getTime() < quietSince;
}

/** The newest moment anything happened to this pull request. */
function quietSinceMs(pr: OpenPullRequest, lastRequestAt: string | null): number {
  return Math.max(
    ...[pr.lastCommitAt, pr.gateVerdictAt, lastRequestAt]
      .filter((at): at is string => at !== null)
      .map((at) => new Date(at).getTime()),
  );
}

/**
 * What foreman says about a stalled pull request: what it can see, and since when. No
 * instruction and no diagnosis, because it does not know which of the two cases this is.
 */
export function stuckReport(pr: OpenPullRequest, lastRequestAt: string | null): string {
  const since = new Date(quietSinceMs(pr, lastRequestAt)).toISOString();
  const checks = pr.failedChecks.length === 0 ? "none red" : pr.failedChecks.join(", ");
  return [
    STUCK_MARKER,
    `Nothing has happened here since ${since}, and this pull request is not merging.`,
    "",
    `- Gate verdict: ${pr.gateVerdict ?? "none"}`,
    `- Gate check on the head commit: ${pr.gateCheckOnHead ? "yes" : "no"}`,
    `- Checks: ${checks}`,
    `- Mergeable: ${pr.mergeable}, state ${pr.mergeState}`,
    `- Auto-merge: ${pr.autoMergeArmed ? "armed" : "not armed"}`,
    "",
    "foreman is reporting this rather than diagnosing it: waiting on a code owner and waiting",
    "on something that will never arrive look the same from here. If it is the former, this is",
    "just a nudge.",
  ].join("\n");
}

/** Posts the report. Separate from deciding to, and from what it says. */
export async function reportStuck(repo: string, pr: number, body: string): Promise<void> {
  await gh(["pr", "comment", String(pr), "--repo", repo, "--body", body]);
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

/**
 * Whether to tell GitHub to merge this pull request once its requirements are met.
 *
 * Enabling auto-merge on the repository only makes the feature available; it still has to be
 * armed per pull request. Nothing armed it, so every pull request reached CLEAN and APPROVED
 * and then sat there, which is the least obvious way for an automated pipeline to stop: each
 * piece reports success and the queue simply never drains.
 *
 * Arming is safe by construction. It never bypasses a rule: GitHub merges only when every
 * required check is green, the Gate has approved, the branch is current, and any CODEOWNERS
 * path has its human approval. Arming a pull request that will never satisfy those does
 * nothing at all.
 */
export function needsAutoMergeArming(pr: { autoMergeArmed: boolean; issue: number | null }): boolean {
  return !pr.autoMergeArmed && pr.issue !== null;
}

/** Tells GitHub to merge once the rules are satisfied. */
export async function armAutoMerge(repo: string, pr: number): Promise<void> {
  await gh(["pr", "merge", String(pr), "--repo", repo, "--auto", "--merge"]);
}
