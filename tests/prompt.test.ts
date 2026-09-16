import { describe, it, expect } from "vitest";
import { buildFixPrompt, buildPrompt } from "../src/prompt.ts";
import type { Ticket } from "../src/gh.ts";

const context = {
  repo: "fieldjw96/rolodeck-ai",
  pullRequest: 127,
  branch: "ticket/121",
  issue: 121,
  baseBranch: "main",
  findings: "Migration 0004's backfill regex truncates at the first period.",
  failedChecks: [] as string[],
  checkLog: "",
  conflicting: false,
};

describe("buildFixPrompt", () => {
  it("names the pull request, the branch and the issue", () => {
    const prompt = buildFixPrompt(context);
    expect(prompt).toContain("#127");
    expect(prompt).toContain("ticket/121");
    expect(prompt).toContain("#121");
  });

  it("carries the findings verbatim, so the Run fixes what was actually raised", () => {
    expect(buildFixPrompt(context)).toContain("truncates at the first period");
  });

  it("names the red checks and their log when there are any", () => {
    const prompt = buildFixPrompt({
      ...context,
      failedChecks: ["ci", "perf"],
      checkLog: "prettier found 3 files",
    });
    expect(prompt).toContain("ci, perf");
    expect(prompt).toContain("prettier found 3 files");
  });

  it("says nothing about checks when none are red", () => {
    expect(buildFixPrompt(context)).not.toContain("are red");
  });

  /**
   * The review workflow matches on the comment *starting* with "/review", so a reply that
   * merely ends with it is ignored and the pull request waits for a review that never runs.
   * Three of mine were swallowed that way before anyone noticed.
   */
  it("insists the review comment is exactly /review", () => {
    expect(buildFixPrompt(context)).toMatch(/exactly "\/review"/);
  });

  /**
   * Git Bash rewrites a bare argument beginning with "/" into a Windows path, so
   * `--body "/review"` posts "C:/Program Files/Git/review" and the job skips. Runs execute
   * on Windows, so a prompt that omits this produces fixes nobody ever re-reviews.
   */
  it("tells the Run how to post it on Windows without the path being mangled", () => {
    const prompt = buildFixPrompt(context);
    expect(prompt).toContain("MSYS_NO_PATHCONV=1");
    expect(prompt).toContain("C:/Program Files/Git/review");
  });

  it("tells a conflicting Run to merge the base branch first", () => {
    const prompt = buildFixPrompt({ ...context, conflicting: true });
    expect(prompt).toContain("git merge origin/main");
    expect(prompt).toContain("no longer merges");
  });

  // Two Tickets each adding a line to the same list is the common case, and taking one side
  // wholesale silently drops the other Ticket's work.
  it("tells it to keep both sides' intent rather than picking one", () => {
    expect(buildFixPrompt({ ...context, conflicting: true })).toContain("almost always both lines");
  });

  it("says nothing about conflicts when there are none", () => {
    expect(buildFixPrompt(context)).not.toContain("no longer merges");
  });

  it("forbids opening a second pull request", () => {
    expect(buildFixPrompt(context)).toContain("Do not open a second pull request");
  });

  it("forbids merging", () => {
    expect(buildFixPrompt(context)).toContain("Do not merge");
  });

  /**
   * A fix Run that holds its work through a long check loses all of it, exactly as a first
   * Run does. Asserted on both prompts rather than one, because they are two copies of the
   * same instructions and a fix applied to only one of them would look done.
   */
  it("tells a fix Run to push before it runs anything slow", () => {
    const prompt = buildFixPrompt(context);
    const push = prompt.indexOf("Commit and push to the existing branch");
    const checks = prompt.indexOf("Run the repo's own checks");
    expect(push).toBeGreaterThan(-1);
    expect(checks).toBeGreaterThan(-1);
    expect(push).toBeLessThan(checks);
  });
});

describe("buildPrompt", () => {
  const ticket: Ticket = {
    number: 121,
    title: "Company Profile gains a location",
    labels: ["lane:claude"],
    repo: "fieldjw96/rolodeck-ai",
    blockedBy: [],
  };

  it("tells a first Run to open a pull request that closes the issue", () => {
    const prompt = buildPrompt(ticket, "ticket/121", "main");
    expect(prompt).toContain("Closes #121");
    expect(prompt).toContain("ticket/121");
  });

  // Without this the supervisor would have to parse an exit code, which lies.
  it("makes opening the pull request the finishing signal", () => {
    expect(buildPrompt(ticket, "ticket/121", "main")).toContain(
      "Opening the pull request is what marks this Run as finished",
    );
  });

  it("forbids merging", () => {
    expect(buildPrompt(ticket, "ticket/121", "main")).toContain("Do not merge");
  });

  /**
   * rolodeck-ai#156 was lost twice this way. Both Runs finished the work, both sat waiting on
   * a suite CI was going to run anyway, both were reaped with nothing committed, and the
   * worktree went with them. The prompt had told them to get the checks passing *before* they
   * pushed, so they did exactly as instructed and the work was unrecoverable.
   */
  it("tells a first Run to push before it runs anything slow", () => {
    const prompt = buildPrompt(ticket, "ticket/121", "main");
    const push = prompt.indexOf('push to "ticket/121"');
    const checks = prompt.indexOf("Run the repo's own checks");
    expect(push).toBeGreaterThan(-1);
    expect(checks).toBeGreaterThan(-1);
    expect(push).toBeLessThan(checks);
  });

  /**
   * Opening the pull request is the finish signal, so it has to stay last. Pushing early is
   * safe; opening early would tell the supervisor a Run had finished while it was still
   * working, and it would stop watching.
   */
  it("still opens the pull request after the checks, not before", () => {
    const prompt = buildPrompt(ticket, "ticket/121", "main");
    expect(prompt.indexOf("Run the repo's own checks")).toBeLessThan(
      prompt.indexOf("Open a pull request"),
    );
  });

  /**
   * The suites CI runs on the pull request are the ones that cost a Run its budget, and a red
   * one already comes back as a fix Run. Running them locally as well buys nothing and has
   * cost two Runs.
   */
  it("tells a Run to leave the end-to-end suites to CI", () => {
    expect(buildPrompt(ticket, "ticket/121", "main")).toContain(
      "Do not run the repo's browser or end-to-end suites locally",
    );
  });
});
