import { describe, it, expect } from "vitest";
import { needsReviewRequest, needsBranchUpdate, REVIEW_COMMAND } from "../src/rereview.ts";
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
