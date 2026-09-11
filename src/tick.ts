import type { Config } from "./config.ts";
import { listTickets, setStatus, comment, findPullRequest, countFailedAttempts, type Ticket } from "./gh.ts";
import { STATUS, ALL_STATUSES } from "./labels.ts";
import { readState, writeState, statePath, isProcessAlive, type LiveRun } from "./state.ts";
import { branchName, worktreePath, createWorktree, removeWorktree } from "./git.ts";
import { launchRun, killRun } from "./launch.ts";
import { classifyRun, freeSlots, chooseTickets, outcomeOf } from "./decide.ts";

export const FAILURE_MARKER = "<!-- foreman:run-failed -->";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function cloneFor(config: Config, repo: string): string {
  const found = config.repos.find((r) => r.name === repo);
  if (!found) throw new Error(`repo ${repo} is not in foreman.config.json`);
  return found.clonePath;
}

/** Ends one Run: label the Ticket by outcome, then take the worktree back. */
async function settle(config: Config, run: LiveRun, timedOut: boolean): Promise<void> {
  const pr = await findPullRequest(run.repo, run.branch);
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

  const tickets: Ticket[] = [];
  for (const repo of config.repos) {
    try {
      tickets.push(...(await listTickets(repo.name)));
    } catch (err) {
      log(`  could not read ${repo.name}: ${(err as Error).message}`);
    }
  }

  for (const ticket of chooseTickets(tickets, stillRunning, slots, config.defaultComplexity)) {
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
