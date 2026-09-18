import { describe, it, expect } from "vitest";
import {
  needsReviewRequest,
  needsBranchUpdate,
  needsAutoMergeArming,
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
