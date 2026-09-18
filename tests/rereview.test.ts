import { describe, it, expect } from "vitest";
import {
  needsReviewRequest,
  needsBranchUpdate,
  needsAutoMergeArming,
  needsStuckReport,
  lastReviewRequestAt,
  lastStuckReportAt,
  stuckReport,
  STUCK_AFTER_MS,
  STUCK_MARKER,
  REVIEW_COMMAND,
} from "../src/rereview.ts";
import type { OpenPullRequest } from "../src/pulls.ts";

const VERDICT = "2026-09-13T18:22:32Z";
const COMMIT_AFTER = "2026-09-13T19:42:37Z";
const COMMIT_BEFORE = "2026-09-13T18:17:04Z";

const pr = (over: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  repo: "o/r",
  number: 127,
  branch: "ticket/121",
  issue: 121,
  lastCommitAt: COMMIT_AFTER,
  gateVerdict: "CHANGES_REQUESTED",
  gateVerdictAt: VERDICT,
  failedChecks: [],
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  autoMergeArmed: true,
  gateCheckFailedAt: null,
  // Present by default, so every test written before this field existed still asks the
  // question it was written to ask: whether the verdict covers the code.
  gateCheckOnHead: true,
  ...over,
});

describe("needsReviewRequest", () => {
  /**
   * rolodeck-ai#127 exactly. A fix Run pushed at 19:42 against a rejection from 18:22, then
   * asked for the re-review through a Windows shell, which rewrote "/review" into
   * "C:/Program Files/Git/review". The pull request sat for an hour waiting on a review
   * nobody had requested, and by the supervisor's own rules it was correctly "waiting" the
   * whole time.
   */
  it("asks when the code has moved past the verdict and nobody has asked", () => {
    expect(needsReviewRequest(pr(), null)).toBe(true);
  });

  // Otherwise the supervisor asks again every five minutes while the review it already
  // requested is still running.
  it("does not ask twice for the same commit", () => {
    expect(needsReviewRequest(pr(), "2026-09-13T19:43:00Z")).toBe(false);
  });

  it("asks again once a newer commit lands after the last request", () => {
    expect(needsReviewRequest(pr({ lastCommitAt: "2026-09-13T20:10:00Z" }), "2026-09-13T19:43:00Z"))
      .toBe(true);
  });

  // A standing rejection against current code is a fix Run's job. Asking for a re-review
  // would get the same answer.
  it("does not ask when the verdict is newer than the code", () => {
    expect(needsReviewRequest(pr({ lastCommitAt: COMMIT_BEFORE }), null)).toBe(false);
  });

  /**
   * The `pull_request` trigger reviews a new pull request on open. Asking again would double
   * every first review, so a pull request with no verdict yet is deliberately left alone.
   */
  it("does not ask when the Gate has never posted a verdict", () => {
    expect(needsReviewRequest(pr({ gateVerdict: null, gateVerdictAt: null }), null)).toBe(false);
  });

  it("asks after an approval that a later commit invalidated", () => {
    expect(needsReviewRequest(pr({ gateVerdict: "APPROVED" }), null)).toBe(true);
  });

  it("treats a commit in the same second as the verdict as already reviewed", () => {
    expect(needsReviewRequest(pr({ lastCommitAt: VERDICT }), null)).toBe(false);
  });

  /**
   * rolodeck-ai#167 and #168. Both were approved after their last commit, so every timestamp
   * said the review covered the code, and both were permanently unmergeable: updating the
   * branch had made a new head, and the Gate check sat on the commit it was posted for. The
   * review workflow's `pull_request` trigger does not fire on a push, so nothing was ever
   * going to post one. Approved, green, mergeable, blocked, and silent about it.
   */
  it("asks when there is no Gate check on the head, even though the verdict is newer", () => {
    const stuck = pr({
      gateVerdict: "APPROVED",
      lastCommitAt: COMMIT_BEFORE,
      gateCheckOnHead: false,
    });
    expect(needsReviewRequest(stuck, null)).toBe(true);
  });

  // The same guard as every other path: one request per commit, not one every tick while the
  // review that was asked for is still running and has yet to post its check.
  it("does not ask twice for a head that still has no check", () => {
    const stuck = pr({ lastCommitAt: COMMIT_BEFORE, gateCheckOnHead: false });
    expect(needsReviewRequest(stuck, "2026-09-13T18:18:00Z")).toBe(false);
  });

  it("asks again when a newer commit lands on a head with no check", () => {
    const stuck = pr({ lastCommitAt: "2026-09-13T20:10:00Z", gateCheckOnHead: false });
    expect(needsReviewRequest(stuck, "2026-09-13T19:43:00Z")).toBe(true);
  });

  /**
   * The missing-check rule must not reach a pull request whose first review has simply not
   * finished yet, or every new pull request would get a second review on top of the one the
   * `pull_request` trigger already started.
   */
  it("still leaves a pull request with no verdict alone when it has no check either", () => {
    const fresh = pr({ gateVerdict: null, gateVerdictAt: null, gateCheckOnHead: false });
    expect(needsReviewRequest(fresh, null)).toBe(false);
  });
});

describe("REVIEW_COMMAND", () => {
  // The workflow matches on the comment *starting* with this, so anything wrapped in prose
  // is silently ignored. Three of these were swallowed before anyone noticed.
  it("is exactly the bare command", () => {
    expect(REVIEW_COMMAND).toBe("/review");
  });
});

describe("needsBranchUpdate", () => {
  /**
   * The ruleset requires a branch to be current before merging, which is what catches the
   * stale-green case. GitHub is meant to update the branch itself once auto-merge is armed
   * and allow_update_branch is on, and on rolodeck-ai it did not: #128, #131 and #132 all
   * sat BEHIND with everything else green and nothing moving.
   */
  it("updates a branch that is merely behind", () => {
    expect(needsBranchUpdate("BEHIND")).toBe(true);
  });

  it("is case-insensitive, because the REST and GraphQL shapes disagree", () => {
    expect(needsBranchUpdate("behind")).toBe(true);
  });

  // A conflict is a Run's job; updating would only produce a conflicted branch.
  it.each(["DIRTY", "CLEAN", "BLOCKED", "UNKNOWN", "UNSTABLE"])(
    "leaves %s alone",
    (state) => {
      expect(needsBranchUpdate(state)).toBe(false);
    },
  );
});

describe("needsAutoMergeArming", () => {
  /**
   * Enabling auto-merge on the repository only makes the feature available; arming it is per
   * pull request. Nothing was doing that, so pull requests reached CLEAN and APPROVED and
   * simply stopped. It is the least obvious way for a pipeline to fail: every part reports
   * success and the queue never drains.
   */
  it("arms a pull request nobody has armed", () => {
    expect(needsAutoMergeArming({ autoMergeArmed: false, issue: 121 })).toBe(true);
  });

  it("leaves an already-armed pull request alone", () => {
    expect(needsAutoMergeArming({ autoMergeArmed: true, issue: 121 })).toBe(false);
  });

  // Same rule as fix Runs: without a Ticket there are no Acceptance Criteria behind it, and
  // a hand-written pull request is a human's to merge.
  it("does not arm a pull request that closes no issue", () => {
    expect(needsAutoMergeArming({ autoMergeArmed: false, issue: null })).toBe(false);
  });
});

describe("needsReviewRequest, after the Gate's check failed", () => {
  const FAILED_AT = "2026-09-14T02:55:34Z";

  /**
   * A review can fail without the branch moving, so the commit-based guard would never ask
   * again and the pull request would sit red for ever. Keyed on when the failure concluded.
   */
  it("asks again after the reviewer failed to finish", () => {
    expect(needsReviewRequest(pr({ gateCheckFailedAt: FAILED_AT }), "2026-09-14T02:50:00Z"))
      .toBe(true);
  });

  it("does not ask twice for the same failure", () => {
    expect(needsReviewRequest(pr({ gateCheckFailedAt: FAILED_AT }), "2026-09-14T02:56:00Z"))
      .toBe(false);
  });

  it("asks when the reviewer failed and nobody has ever asked", () => {
    expect(needsReviewRequest(pr({ gateCheckFailedAt: FAILED_AT }), null)).toBe(true);
  });
});

describe("reading a pull request's comments", () => {
  const comments = [
    { body: "Looks good to me", createdAt: "2026-09-13T10:00:00Z" },
    { body: "/review", createdAt: "2026-09-13T11:00:00Z" },
    { body: `${STUCK_MARKER}\nNothing has happened here since...`, createdAt: "2026-09-13T12:00:00Z" },
    { body: "/review", createdAt: "2026-09-13T13:00:00Z" },
  ];

  it("takes the latest review request, whoever posted it", () => {
    expect(lastReviewRequestAt(comments)).toBe("2026-09-13T13:00:00Z");
  });

  // The workflow matches on the comment *starting* with the command, and so does this.
  it("does not count a comment that merely mentions the command", () => {
    const prose = [{ body: "I think we should /review this again", createdAt: "2026-09-13T14:00:00Z" }];
    expect(lastReviewRequestAt(prose)).toBeNull();
  });

  it("finds its own stuck report by marker", () => {
    expect(lastStuckReportAt(comments)).toBe("2026-09-13T12:00:00Z");
  });

  it("reports nothing when it has never spoken", () => {
    expect(lastStuckReportAt([{ body: "/review", createdAt: "2026-09-13T11:00:00Z" }])).toBeNull();
  });
});

describe("needsStuckReport", () => {
  const QUIET = "2026-09-13T12:00:00Z";
  const quietFor = (ms: number) => new Date(new Date(QUIET).getTime() + ms);
  // A pull request whose newest activity is QUIET: waiting, approved, and not moving.
  const stalled = pr({
    gateVerdict: "APPROVED",
    gateVerdictAt: QUIET,
    lastCommitAt: "2026-09-13T11:30:00Z",
    mergeState: "BLOCKED",
  });

  /**
   * rolodeck-ai#167 and #168. Both sat approved, green, mergeable and unmergeable overnight,
   * and were found only because a person asked whether anything needed attention. Nothing in
   * the supervisor was watching the one state that can last forever.
   */
  it("speaks once a waiting pull request has been quiet for the threshold", () => {
    expect(needsStuckReport(stalled, null, null, false, quietFor(STUCK_AFTER_MS))).toBe(true);
  });

  it("stays quiet before the threshold", () => {
    expect(needsStuckReport(stalled, null, null, false, quietFor(STUCK_AFTER_MS - 1000))).toBe(false);
  });

  // A Run against this branch is the thing that will move it, and may take most of an hour
  // before it pushes anything.
  it("says nothing while a Run is working on the branch", () => {
    expect(needsStuckReport(stalled, null, null, true, quietFor(STUCK_AFTER_MS * 10))).toBe(false);
  });

  it("does not repeat itself while the pull request stays quiet", () => {
    const reportedAt = new Date(quietFor(STUCK_AFTER_MS).getTime()).toISOString();
    expect(needsStuckReport(stalled, null, reportedAt, false, quietFor(STUCK_AFTER_MS * 2))).toBe(false);
  });

  // A report older than the newest activity belongs to a previous stall. This is a new one.
  it("speaks again about a fresh stall after something happened in between", () => {
    const moved = pr({
      gateVerdict: "APPROVED",
      gateVerdictAt: "2026-09-14T09:00:00Z",
      lastCommitAt: "2026-09-14T09:00:00Z",
    });
    const now = new Date(new Date("2026-09-14T09:00:00Z").getTime() + STUCK_AFTER_MS);
    expect(needsStuckReport(moved, null, "2026-09-13T15:00:00Z", false, now)).toBe(true);
  });

  // Asking for a review is something happening, so the clock restarts from the request.
  it("counts a review request as progress", () => {
    const askedAt = new Date(quietFor(STUCK_AFTER_MS - 1000).getTime()).toISOString();
    expect(needsStuckReport(stalled, askedAt, null, false, quietFor(STUCK_AFTER_MS))).toBe(false);
  });
});

describe("stuckReport", () => {
  it("carries the marker, so foreman can find its own report later", () => {
    expect(stuckReport(pr(), null)).toContain(STUCK_MARKER);
  });

  /**
   * It reports rather than diagnoses: a pull request blocked on a code owner looks the same
   * from here as one blocked on a check nobody will post. The body must therefore state what
   * was observed, so a reader can tell which it is.
   */
  it("states what it can see rather than what it thinks", () => {
    const body = stuckReport(
      pr({ gateVerdict: "APPROVED", gateCheckOnHead: false, mergeState: "BLOCKED", failedChecks: [] }),
      null,
    );
    expect(body).toContain("APPROVED");
    expect(body).toContain("Gate check on the head commit: no");
    expect(body).toContain("BLOCKED");
    expect(body).toContain("none red");
  });

  it("names the red checks when there are any", () => {
    expect(stuckReport(pr({ failedChecks: ["ci", "perf"] }), null)).toContain("ci, perf");
  });
});
