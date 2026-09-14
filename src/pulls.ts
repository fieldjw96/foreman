import { gh } from "./gh.ts";

/**
 * An open pull request, reduced to the facts that decide whether a Run should be sent back
 * to it: when its branch last changed, what the Gate last said and when, and which checks
 * are currently red.
 */
export type OpenPullRequest = {
  repo: string;
  number: number;
  branch: string;
  issue: number | null;
  lastCommitAt: string;
  gateVerdict: "APPROVED" | "CHANGES_REQUESTED" | null;
  gateVerdictAt: string | null;
  failedChecks: string[];
  /**
   * GitHub's own view of whether this branch still merges. UNKNOWN means it has not finished
   * working it out, and must never be read as either answer.
   */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /**
   * GitHub's finer-grained view. "behind" is the one that matters here: the branch merges
   * cleanly but is out of date, and the ruleset requires it to be current.
   */
  mergeState: string;
  /** Whether GitHub has been told to merge this once its requirements are met. */
  autoMergeArmed: boolean;
  /**
   * When the Gate's own check last concluded in failure, if it did. Distinct from a verdict:
   * this is the reviewer failing to finish rather than the reviewer objecting.
   */
  gateCheckFailedAt: string | null;
};

type RawReview = { author: { login: string } | null; state: string; submittedAt: string };

/** The issue a pull request closes, read from "Closes #N" in its body. */
export function closesIssue(body: string): number | null {
  const match = /\b(?:closes|fixes|resolves)\s+#(\d+)\b/i.exec(body);
  return match ? Number(match[1]) : null;
}

/**
 * The Gate's own latest verdict. Carried over from the archived harness's ADR 0010, which
 * was written after two deadlocks: only APPROVED and CHANGES_REQUESTED are verdicts, so a
 * COMMENTED review neither approves nor blocks, and only the latest one counts. The Gate is
 * identified by login so replacing the reviewer is configuration rather than a code change.
 */
export function latestGateVerdict(
  reviews: RawReview[],
  gateLogin: string,
): { state: "APPROVED" | "CHANGES_REQUESTED"; at: string } | null {
  const verdicts = reviews
    .filter((r) => r.author?.login === gateLogin)
    .filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED");
  const last = verdicts[verdicts.length - 1];
  if (last === undefined) return null;
  return { state: last.state as "APPROVED" | "CHANGES_REQUESTED", at: last.submittedAt };
}

export async function listOpenPullRequests(
  repo: string,
  gateLogin: string,
): Promise<OpenPullRequest[]> {
  const out = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    // 20, not 50. Each pull request here carries its commits, its reviews and its whole
    // check rollup, and GitHub costs a GraphQL query by the nodes it *could* return rather
    // than the ones it does. At 50 this asks for 515,100 against a ceiling of 500,000 and
    // fails outright. Twenty is far more open pull requests than this system should ever
    // have at once, and if it does, the oldest are the ones that need a human anyway.
    "--limit",
    "20",
    "--json",
    "number,headRefName,body,commits,reviews,statusCheckRollup,mergeable,mergeStateStatus,autoMergeRequest",
  ]);

  const rows = JSON.parse(out) as {
    number: number;
    headRefName: string;
    body: string | null;
    commits: { committedDate: string }[] | null;
    reviews: RawReview[] | null;
    statusCheckRollup:
      | { name?: string; conclusion?: string; completedAt?: string }[]
      | null;
    mergeable: string | null;
    mergeStateStatus: string | null;
    autoMergeRequest: unknown;
  }[];

  return rows.map((row) => {
    const verdict = latestGateVerdict(row.reviews ?? [], gateLogin);
    const commits = row.commits ?? [];
    return {
      repo,
      number: row.number,
      branch: row.headRefName,
      issue: closesIssue(row.body ?? ""),
      lastCommitAt: commits[commits.length - 1]?.committedDate ?? new Date(0).toISOString(),
      gateVerdict: verdict?.state ?? null,
      gateVerdictAt: verdict?.at ?? null,
      failedChecks: (row.statusCheckRollup ?? [])
        .filter((check) => check.conclusion === "FAILURE")
        .map((check) => check.name ?? "unnamed"),
      mergeable:
        row.mergeable === "MERGEABLE" || row.mergeable === "CONFLICTING"
          ? row.mergeable
          : "UNKNOWN",
      mergeState: row.mergeStateStatus ?? "UNKNOWN",
      autoMergeArmed: row.autoMergeRequest !== null && row.autoMergeRequest !== undefined,
      gateCheckFailedAt:
        (row.statusCheckRollup ?? []).find(
          (c) => c.name === "review" && c.conclusion === "FAILURE",
        )?.completedAt ?? null,
    };
  });
}

/**
 * What the Gate actually objected to, as the text a Run needs in order to act on it. Both
 * halves matter: the verdict body carries the headline finding, and the inline comments
 * carry the ones attached to particular lines.
 */
export async function reviewFindings(
  repo: string,
  pr: number,
  gateLogin: string,
): Promise<string> {
  const out = await gh(["pr", "view", String(pr), "--repo", repo, "--json", "reviews,comments"]);
  const data = JSON.parse(out) as {
    reviews: (RawReview & { body: string })[] | null;
    comments: { author: { login: string } | null; body: string }[] | null;
  };

  const rejections = (data.reviews ?? []).filter(
    (r) => r.author?.login === gateLogin && r.state === "CHANGES_REQUESTED",
  );
  const verdict = rejections[rejections.length - 1];

  const inline = (data.comments ?? [])
    .filter((c) => c.author?.login === gateLogin)
    .map((c) => c.body)
    .join("\n\n");

  return [verdict?.body ?? "", inline].filter((part) => part !== "").join("\n\n").trim();
}

/** The tail of whatever failed on this branch, for a Run that has to fix it. */
export async function failedCheckLog(repo: string, branch: string, lines = 80): Promise<string> {
  try {
    const ids = await gh([
      "run",
      "list",
      "--repo",
      repo,
      "--branch",
      branch,
      "--limit",
      "1",
      "--json",
      "databaseId",
      "--jq",
      ".[0].databaseId",
    ]);
    const id = ids.trim();
    if (id === "") return "";
    const log = await gh(["run", "view", id, "--repo", repo, "--log-failed"]);
    return log.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    // A log we cannot read is not a reason to skip the fix. The Run can re-run the checks.
    return "";
  }
}
