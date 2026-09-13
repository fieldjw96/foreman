import { repoRoot, type Config } from "./config.ts";
import { listTickets, setStatus, comment, findPullRequest, countFailedAttempts, type Ticket } from "./gh.ts";
import { STATUS, ALL_STATUSES } from "./labels.ts";
import { readState, writeState, statePath, isProcessAlive, type LiveRun } from "./state.ts";
import { branchName, worktreePath, createWorktree, removeWorktree, checkoutExistingBranch } from "./git.ts";
import { launchRun, killRun } from "./launch.ts";
import { classifyRun, freeSlots, chooseTickets, outcomeOf } from "./decide.ts";
import { acquireLock, releaseLock, lockPath } from "./lock.ts";
import { listOpenPullRequests, reviewFindings, failedCheckLog, type OpenPullRequest } from "./pulls.ts";
import { chooseFixes, classifyPullRequest } from "./fix.ts";
import { needsReviewRequest, lastReviewRequestAt, requestReview } from "./rereview.ts";
import { buildFixPrompt } from "./prompt.ts";
import { selfUpdate } from "./selfupdate.ts";

export const FAILURE_MARKER = "<!-- foreman:run-failed -->";
export const FIX_MARKER = "<!-- foreman:fix-run -->";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function cloneFor(config: Config, repo: string): string {
  const found = config.repos.find((r) => r.name === repo);
  if (!found) throw new Error(`repo ${repo} is not in foreman.config.json`);
  return found.clonePath;
}

/** Ends one Run: label the Ticket by outcome, then take the worktree back. */
async function settle(config: Config, run: LiveRun, timedOut: boolean): Promise<void> {
  // Anchored to when this Run started, so a pull request from an earlier attempt on the
  // same branch cannot be mistaken for this Run's work.
  const pr = await findPullRequest(run.repo, run.branch, new Date(run.startedAt));
  const priorFailures = pr === null ? await countFailedAttempts(run.repo, run.issue, FAILURE_MARKER) : 0;
  const outcome = outcomeOf(pr, priorFailures, config.maxAttempts);

  if (outcome === "review") {
    log(`  #${run.issue} opened PR #${pr} -> status:review`);
    await setStatus(run.repo, run.issue, STATUS.review, ALL_STATUSES);
  } else {
    const why = timedOut
      ? `timed out after ${config.runTimeoutMinutes} minutes and was killed`
      : "ended without opening a pull request";
    await comment(
      run.repo,
      run.issue,
      `${FAILURE_MARKER}\nRun ${why}. Log: \`${run.logFile}\` on the server laptop.`,
    );
    const next = outcome === "retry" ? STATUS.ready : STATUS.needsHuman;
    log(`  #${run.issue} ${why} -> ${next}`);
    await setStatus(run.repo, run.issue, next, ALL_STATUSES);
  }

  await removeWorktree(cloneFor(config, run.repo), run.worktree);
}

/**
 * One tick. Reap, then claim, then return. It does not wait for anything it started, which
 * is the entire difference between this and the harness it replaces.
 */
export async function tick(config: Config): Promise<void> {
  const lock = lockPath(config.worktreeRoot);
  const held = acquireLock(lock);
  if (!held.ok) {
    log(`another tick is running (pid ${held.heldBy}); doing nothing`);
    return;
  }
  try {
    // Inside the lock, before anything is read. A merged change to foreman otherwise does
    // nothing until somebody remembers to pull on the server laptop, and the only symptom is
    // work quietly not being picked up. The new code takes effect on the *next* tick, since
    // this process is already loaded; that is deliberate, because swapping the code out from
    // under a tick already in progress is how the harness this replaces got into trouble.
    const update = await selfUpdate(repoRoot);
    if (update.changed) {
      log(`updated foreman ${update.from} -> ${update.to}; it takes effect next tick`);
    }

    await runTick(config);
  } finally {
    releaseLock(lock);
  }
}

async function runTick(config: Config): Promise<void> {
  const path = statePath(config.worktreeRoot);
  const state = readState(path);
  const stillRunning: LiveRun[] = [];

  for (const run of state.runs) {
    const verdict = classifyRun(run, isProcessAlive(run.pid), config.runTimeoutMinutes);
    if (verdict === "alive") {
      stillRunning.push(run);
      continue;
    }
    if (verdict === "timed-out") killRun(run.pid);
    try {
      await settle(config, run, verdict === "timed-out");
    } catch (err) {
      // Leave it out of state either way. A Run whose settle failed is finished; retrying
      // the settle for ever would hold a slot on a process that no longer exists.
      log(`  #${run.issue} could not be settled cleanly: ${(err as Error).message}`);
    }
  }

  const slots = freeSlots(config.maxConcurrent, stillRunning.length);
  log(`${stillRunning.length} running, ${slots} slot(s) free`);
  if (slots === 0) {
    writeState(path, { runs: stillRunning });
    return;
  }

  // Finishing work comes before starting more of it. An open pull request that was rejected
  // or has gone red is the closest thing to done in the system, and leaving it while new
  // Runs land on main is exactly how two pull requests ended up unmergeable against a branch
  // that had moved twice underneath them.
  let remaining = slots;
  const pulls: OpenPullRequest[] = [];
  for (const repo of config.repos) {
    try {
      pulls.push(...(await listOpenPullRequests(repo.name, config.gateReviewer)));
    } catch (err) {
      log(`  could not read pull requests on ${repo.name}: ${(err as Error).message}`);
    }
  }

  // Ask for the review a waiting pull request is waiting on. Leaving this to the Run that
  // pushed the fix is what stranded rolodeck-ai#127 for an hour: it posted its request
  // through a Windows shell, which rewrote "/review" into a file path, and nothing was ever
  // going to notice. Costs one API call per waiting pull request and asks at most once per
  // commit.
  for (const pr of pulls) {
    if (classifyPullRequest(pr) !== "waiting") continue;
    try {
      if (!needsReviewRequest(pr, await lastReviewRequestAt(pr.repo, pr.number))) continue;
      await requestReview(pr.repo, pr.number);
      log(`  asked for a fresh review on PR #${pr.number}`);
    } catch (err) {
      log(`  could not request a review on PR #${pr.number}: ${(err as Error).message}`);
    }
  }

  for (const pr of chooseFixes(pulls, stillRunning, remaining)) {
    const repo = config.repos.find((r) => r.name === pr.repo)!;
    const issue = pr.issue!;
    const worktree = worktreePath(config.worktreeRoot, pr.repo, issue);
    try {
      const attempts = await countFailedAttempts(pr.repo, issue, FIX_MARKER);
      if (attempts >= config.maxFixAttempts) {
        log(`  #${issue} has already had ${attempts} fix Runs; leaving it for a human`);
        await setStatus(pr.repo, issue, STATUS.needsHuman, ALL_STATUSES);
        continue;
      }

      const tickets = await listTickets(pr.repo);
      const ticket = tickets.find((t) => t.number === issue);
      if (ticket === undefined) {
        log(`  #${issue} has no open Ticket; not fixing PR #${pr.number}`);
        continue;
      }

      await comment(
        pr.repo,
        issue,
        `${FIX_MARKER}\nSending a Run back to pull request #${pr.number}: ` +
          (pr.mergeable === "CONFLICTING"
            ? "it no longer merges into the base branch."
            : pr.failedChecks.length > 0
              ? `checks are red (${pr.failedChecks.join(", ")}).`
              : "the review Gate asked for changes."),
      );
      await setStatus(pr.repo, issue, STATUS.running, ALL_STATUSES);
      await checkoutExistingBranch(repo.clonePath, worktree, pr.branch);

      const prompt = buildFixPrompt({
        repo: pr.repo,
        pullRequest: pr.number,
        branch: pr.branch,
        baseBranch: repo.baseBranch,
        issue,
        findings: await reviewFindings(pr.repo, pr.number, config.gateReviewer),
        failedChecks: pr.failedChecks,
        checkLog: pr.failedChecks.length > 0 ? await failedCheckLog(pr.repo, pr.branch) : "",
        conflicting: pr.mergeable === "CONFLICTING",
      });

      const startedAt = new Date();
      const { pid, logFile } = launchRun(
        config, ticket, worktree, pr.branch, repo.baseBranch, startedAt, prompt,
      );
      stillRunning.push({
        repo: pr.repo,
        issue,
        pid,
        branch: pr.branch,
        worktree,
        logFile,
        startedAt: startedAt.toISOString(),
      });
      remaining -= 1;
      log(`  fixing #${issue} (PR #${pr.number}) as pid ${pid}`);
    } catch (err) {
      log(`  could not start a fix for #${issue}: ${(err as Error).message}`);
      await setStatus(pr.repo, issue, STATUS.review, ALL_STATUSES).catch(() => {});
      await removeWorktree(repo.clonePath, worktree).catch(() => {});
    }
  }

  if (remaining === 0) {
    writeState(path, { runs: stillRunning });
    return;
  }

  const tickets: Ticket[] = [];
  for (const repo of config.repos) {
    try {
      tickets.push(...(await listTickets(repo.name)));
    } catch (err) {
      log(`  could not read ${repo.name}: ${(err as Error).message}`);
    }
  }

  for (const ticket of chooseTickets(tickets, stillRunning, remaining, config.defaultComplexity)) {
    const repo = config.repos.find((r) => r.name === ticket.repo)!;
    const branch = branchName(ticket.number);
    const worktree = worktreePath(config.worktreeRoot, ticket.repo, ticket.number);
    try {
      // Claim first. If this fails the Ticket is untouched and the next tick tries again.
      await setStatus(ticket.repo, ticket.number, STATUS.running, ALL_STATUSES);
      await createWorktree(repo.clonePath, worktree, branch, repo.baseBranch);
      const startedAt = new Date();
      const { pid, logFile } = launchRun(config, ticket, worktree, branch, repo.baseBranch, startedAt);
      stillRunning.push({
        repo: ticket.repo,
        issue: ticket.number,
        pid,
        branch,
        worktree,
        logFile,
        startedAt: startedAt.toISOString(),
      });
      log(`  started #${ticket.number} as pid ${pid} in ${worktree}`);
    } catch (err) {
      log(`  could not start #${ticket.number}: ${(err as Error).message}`);
      await setStatus(ticket.repo, ticket.number, STATUS.ready, ALL_STATUSES).catch(() => {});
      await removeWorktree(repo.clonePath, worktree).catch(() => {});
    }
  }

  writeState(path, { runs: stillRunning });
}
