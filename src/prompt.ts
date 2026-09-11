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
