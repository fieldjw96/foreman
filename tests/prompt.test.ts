import { describe, it, expect } from "vitest";
import { buildFixPrompt, buildPrompt } from "../src/prompt.ts";
import type { Ticket } from "../src/gh.ts";

const context = {
  repo: "fieldjw96/rolodeck-ai",
  pullRequest: 127,
  branch: "ticket/121",
  issue: 121,
  findings: "Migration 0004's backfill regex truncates at the first period.",
  failedChecks: [] as string[],
  checkLog: "",
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

  it("forbids opening a second pull request", () => {
    expect(buildFixPrompt(context)).toContain("Do not open a second pull request");
  });

  it("forbids merging", () => {
    expect(buildFixPrompt(context)).toContain("Do not merge");
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
});
