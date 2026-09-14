import { describe, it, expect } from "vitest";
import { classifyPullRequest, chooseFixes } from "../src/fix.ts";
import { closesIssue, latestGateVerdict } from "../src/pulls.ts";
import type { OpenPullRequest } from "../src/pulls.ts";
import type { LiveRun } from "../src/state.ts";

const COMMIT = "2026-09-13T18:17:04Z";
const BEFORE = "2026-09-13T18:10:00Z";
const AFTER = "2026-09-13T18:22:32Z";

const pr = (over: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  repo: "o/r",
  number: 127,
  branch: "ticket/121",
  issue: 121,
  lastCommitAt: COMMIT,
  gateVerdict: null,
  gateVerdictAt: null,
  failedChecks: [],
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  autoMergeArmed: true,
  ...over,
});

const run = (over: Partial<LiveRun> = {}): LiveRun => ({
  repo: "o/r",
  issue: 121,
  pid: 100,
  branch: "ticket/121",
  worktree: "C:/agent-runs/r/121",
  logFile: "x.log",
  startedAt: COMMIT,
  ...over,
});

describe("classifyPullRequest", () => {
  /**
   * The real case this was built for: PR #127 on rolodeck-ai, committed 18:17:04, rejected
   * by the Gate at 18:22:32 over a migration regex that truncated a city name at the first
   * period. Six checks were green. Only the review caught it.
   */
  it("sends a Run back when the rejection is newer than the code", () => {
    expect(classifyPullRequest(pr({ gateVerdict: "CHANGES_REQUESTED", gateVerdictAt: AFTER })))
      .toBe("needs-fix");
  });

  /**
   * The failure the archived harness kept hitting: it re-ran Tickets whose cause had
   * "plausibly changed" and so re-did work against a complaint that had already been
   * answered. A commit newer than the verdict means the fix is pushed and a re-review is
   * what is owed, not another Run.
   */
  it("waits when a fix has already been pushed since the rejection", () => {
    expect(classifyPullRequest(pr({ gateVerdict: "CHANGES_REQUESTED", gateVerdictAt: BEFORE })))
      .toBe("waiting");
  });

  it("treats a verdict landing in the same second as the commit as already answered", () => {
    expect(classifyPullRequest(pr({ gateVerdict: "CHANGES_REQUESTED", gateVerdictAt: COMMIT })))
      .toBe("waiting");
  });

  // A check is attached to a commit by GitHub, so a red one is always about current code.
  it("sends a Run back for a red check whatever the Gate said", () => {
    expect(classifyPullRequest(pr({ failedChecks: ["ci"] }))).toBe("needs-fix");
    expect(
      classifyPullRequest(pr({ failedChecks: ["ci"], gateVerdict: "APPROVED", gateVerdictAt: AFTER })),
    ).toBe("needs-fix");
  });

  it("calls an approval of current code ready to merge", () => {
    expect(classifyPullRequest(pr({ gateVerdict: "APPROVED", gateVerdictAt: AFTER })))
      .toBe("ready-to-merge");
  });

  /**
   * Stale green, which is what bit rolodeck-ai#120: approved and green, then another Ticket
   * merged, then thirteen tests failed against the new main. An approval older than the code
   * it approves is not an approval of this code.
   */
  it("does not call a stale approval ready to merge", () => {
    expect(classifyPullRequest(pr({ gateVerdict: "APPROVED", gateVerdictAt: BEFORE })))
      .toBe("waiting");
  });

  /**
   * Silence is never a verdict. The reviewer can fail for reasons unrelated to the code: on
   * rolodeck-ai#117 it exhausted its 40-turn budget on a 14-file diff and posted nothing.
   */
  it("waits when there is no verdict at all", () => {
    expect(classifyPullRequest(pr())).toBe("waiting");
    expect(classifyPullRequest(pr({ gateVerdict: null, gateVerdictAt: null }))).toBe("waiting");
  });
});

describe("classifyPullRequest, conflicts", () => {
  /**
   * The failure that killed PRs #56 and #59 under the archived harness: they sat approved
   * while other work merged beneath them, went unmergeable, and were closed rather than
   * finished. Nothing was looking at mergeability, so nothing noticed.
   */
  it("sends a Run back to a conflicting pull request even when the Gate approved it", () => {
    expect(
      classifyPullRequest(
        pr({ mergeable: "CONFLICTING", gateVerdict: "APPROVED", gateVerdictAt: AFTER }),
      ),
    ).toBe("needs-fix");
  });

  it("sends a Run back to a conflicting pull request with every check green", () => {
    expect(classifyPullRequest(pr({ mergeable: "CONFLICTING", failedChecks: [] })))
      .toBe("needs-fix");
  });

  // GitHub reports UNKNOWN while it is still working the answer out. Treating that as a
  // conflict would send a Run at every pull request the moment it opened.
  it("does not treat UNKNOWN as a conflict", () => {
    expect(classifyPullRequest(pr({ mergeable: "UNKNOWN", gateVerdict: "APPROVED", gateVerdictAt: AFTER })))
      .toBe("ready-to-merge");
  });
});

describe("chooseFixes", () => {
  it("takes only the ones needing a fix", () => {
    const picked = chooseFixes(
      [
        pr({ number: 1, issue: 1, gateVerdict: "CHANGES_REQUESTED", gateVerdictAt: AFTER }),
        pr({ number: 2, issue: 2, gateVerdict: "APPROVED", gateVerdictAt: AFTER }),
        pr({ number: 3, issue: 3 }),
      ],
      [], 5,
    );
    expect(picked.map((p) => p.number)).toEqual([1]);
  });

  it("respects the slot count", () => {
    const pulls = [1, 2, 3].map((n) =>
      pr({ number: n, issue: n, failedChecks: ["ci"] }),
    );
    expect(chooseFixes(pulls, [], 2)).toHaveLength(2);
  });

  // A second Run on one branch would have both pushing to it.
  it("skips a pull request whose Ticket already has a Run", () => {
    const picked = chooseFixes(
      [
        pr({ number: 1, issue: 121, failedChecks: ["ci"] }),
        pr({ number: 2, issue: 122, failedChecks: ["ci"] }),
      ],
      [run({ issue: 121 })], 5,
    );
    expect(picked.map((p) => p.issue)).toEqual([122]);
  });

  it("does not confuse the same issue number in two repos", () => {
    const other = pr({ repo: "o/other", issue: 121, failedChecks: ["ci"] });
    expect(chooseFixes([other], [run({ issue: 121, repo: "o/r" })], 5)).toHaveLength(1);
  });

  // Without a Ticket there is nothing to label, and no Acceptance Criteria to fix against.
  it("ignores a pull request that closes no issue", () => {
    expect(chooseFixes([pr({ issue: null, failedChecks: ["ci"] })], [], 5)).toEqual([]);
  });

  it("returns nothing when there are no slots", () => {
    expect(chooseFixes([pr({ failedChecks: ["ci"] })], [], 0)).toEqual([]);
  });
});

describe("closesIssue", () => {
  it.each([
    ["Closes #121", 121],
    ["closes #7", 7],
    ["Fixes #42 and more", 42],
    ["Resolves #9.", 9],
  ])("reads %s", (body, expected) => {
    expect(closesIssue(body)).toBe(expected);
  });

  it("returns null when the body names no issue", () => {
    expect(closesIssue("A pull request that forgot to say.")).toBeNull();
  });

  // "#121" alone is how people reference an issue in passing, not how they close one.
  it("does not treat a bare reference as a close", () => {
    expect(closesIssue("Related to #121 but does not close it")).toBeNull();
  });
});

describe("latestGateVerdict", () => {
  const review = (login: string, state: string, at: string) => ({
    author: { login },
    state,
    submittedAt: at,
  });

  it("takes the Gate's latest verdict", () => {
    const v = latestGateVerdict(
      [
        review("github-actions", "CHANGES_REQUESTED", BEFORE),
        review("github-actions", "APPROVED", AFTER),
      ],
      "github-actions",
    );
    expect(v).toEqual({ state: "APPROVED", at: AFTER });
  });

  // Copilot posts these, and they are not a verdict either way.
  it("ignores COMMENTED", () => {
    const v = latestGateVerdict(
      [
        review("github-actions", "CHANGES_REQUESTED", BEFORE),
        review("github-actions", "COMMENTED", AFTER),
      ],
      "github-actions",
    );
    expect(v).toEqual({ state: "CHANGES_REQUESTED", at: BEFORE });
  });

  it("ignores other reviewers", () => {
    expect(latestGateVerdict([review("someone", "APPROVED", AFTER)], "github-actions")).toBeNull();
  });

  it("returns null when the Gate has not reviewed", () => {
    expect(latestGateVerdict([], "github-actions")).toBeNull();
  });

  it("survives a review whose author GitHub reports as null", () => {
    const reviews = [{ author: null, state: "APPROVED", submittedAt: AFTER }];
    expect(latestGateVerdict(reviews, "github-actions")).toBeNull();
  });
});
