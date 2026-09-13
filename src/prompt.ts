import type { Ticket } from "./gh.ts";

/**
 * The Run opens its own pull request. That is what lets the supervisor stay dumb: it never
 * has to parse an exit code or scrape a log, it just asks GitHub whether a pull request
 * exists on the branch.
 */
export function buildPrompt(ticket: Ticket, branch: string, baseBranch: string): string {
  return [
    `You are completing GitHub issue #${ticket.number} in ${ticket.repo}: "${ticket.title}".`,
    "",
    "You are in a git worktree on local disk, already on the correct branch.",
    "",
    "Do this:",
    `1. Read the issue with: gh issue view ${ticket.number} --repo ${ticket.repo}`,
    "2. Read CLAUDE.md and CONTEXT.md if they exist, and any ADR the issue depends on.",
    "3. Plan the change before editing. State the plan, then implement it.",
    "4. Satisfy every Acceptance Criterion in the issue. Each one is meant to be checkable;",
    "   if one genuinely cannot be met, do the rest and say which and why in the pull request.",
    "5. Run the repo's own checks and get them passing before you push.",
    "6. Review your own diff cold, as if someone else wrote it, and fix what you find.",
    `7. Commit, push to "${branch}", and open a pull request against "${baseBranch}" with`,
    `   "Closes #${ticket.number}" in the body. This branch was created fresh from`,
    `   "${baseBranch}", so if the remote already has "${branch}" from an earlier attempt,`,
    "   push with --force-with-lease. Replacing it is correct; the old attempt is superseded.",
    "",
    "Rules:",
    "- Do not merge the pull request. A human decides that.",
    "- Do not edit the issue's labels. The supervisor owns those.",
    "- Do not write secrets into any file. They are in your environment already.",
    "- Stay inside this worktree. Do not touch other repositories.",
    "",
    "Opening the pull request is what marks this Run as finished. If you cannot finish the",
    "work, still push what you have and open a draft pull request explaining where you got to.",
  ].join("\n");
}

export type FixContext = {
  repo: string;
  pullRequest: number;
  branch: string;
  issue: number;
  findings: string;
  failedChecks: string[];
  checkLog: string;
};

/**
 * A Run sent back to a pull request the Gate rejected, or whose checks went red.
 *
 * It is told to push to the existing branch and re-request review, never to open a second
 * pull request. Pushing is what marks it finished, the same way opening one does for a first
 * Run, so the supervisor still never has to read an exit code.
 */
export function buildFixPrompt(context: FixContext): string {
  const lines = [
    `Pull request #${context.pullRequest} in ${context.repo} needs fixing. It is on branch`,
    `"${context.branch}" and closes issue #${context.issue}.`,
    "",
    "You are in a git worktree on local disk, already on that branch, with the work already",
    "on it. You are fixing it, not starting again.",
    "",
  ];

  if (context.failedChecks.length > 0) {
    lines.push(`These required checks are red: ${context.failedChecks.join(", ")}.`, "");
    if (context.checkLog !== "") {
      lines.push("The tail of the failing log:", "", "```", context.checkLog, "```", "");
    }
  }

  if (context.findings !== "") {
    lines.push("The review Gate asked for changes:", "", context.findings, "");
  }

  lines.push(
    "Do this:",
    `1. Read the issue with: gh issue view ${context.issue} --repo ${context.repo}`,
    "2. Read the findings above and the code they point at before changing anything.",
    "3. Fix the cause rather than the symptom. If a finding is wrong, say so in a pull",
    "   request comment with your reasoning instead of changing correct code.",
    "4. Run the repo's own checks, including the formatter, and get them passing.",
    "5. Commit and push to the existing branch. Do not open a second pull request.",
    `6. Request a fresh review on pull request #${context.pullRequest}. The comment body must`,
    '   be exactly "/review" and nothing else, because the workflow matches on the comment',
    '   *starting* with it: prose that merely ends with "/review" is ignored, and the pull',
    "   request then waits for a review that will never run. Post it with:",
    "",
    `     MSYS_NO_PATHCONV=1 gh pr comment ${context.pullRequest} --repo ${context.repo} --body "/review"`,
    "",
    "   MSYS_NO_PATHCONV=1 is not optional on Windows. Git Bash rewrites a bare argument",
    '   beginning with "/" into a Windows path, so --body "/review" arrives as',
    '   "C:/Program Files/Git/review" and the job skips. PowerShell or --body-file work too;',
    "   what matters is that the posted comment reads exactly /review.",
    "",
    "Rules:",
    "- Do not merge. A human or the merge rules decide that.",
    "- Do not edit the issue's labels. The supervisor owns those.",
    "- Do not force-push in a way that discards commits you did not write.",
    "- Do not write secrets into any file. They are in your environment already.",
    "",
    "Pushing to the branch is what marks this Run as finished.",
  );

  return lines.join("\n");
}
