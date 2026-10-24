import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "./config.ts";
import type { Ticket } from "./gh.ts";
import { loadRunSecrets } from "./secrets.ts";
import { buildPrompt, buildScoutPrompt } from "./prompt.ts";
import { complexityOf } from "./labels.ts";

export const ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "TodoWrite", "Task",
  "Bash", "PowerShell",
].join(",");

export function logPath(worktreeRoot: string, issue: number, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return join(worktreeRoot, "logs", `ticket-${issue}-${stamp}.log`);
}

export function scoutLogPath(worktreeRoot: string, repo: string, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return join(worktreeRoot, "logs", `scout-${repo.split("/")[1] ?? repo}-${stamp}.log`);
}

/**
 * A Scout reads and reports; it does not write. No Write or Edit, and its shell reaches only
 * the read-only gh and git commands it needs for history. It prints its Pitches rather than
 * writing them to a file, so it needs nothing that could change the worktree at all.
 */
export const SCOUT_TOOLS = [
  "Read", "Glob", "Grep", "WebFetch", "WebSearch",
  "Bash(gh issue list:*)", "Bash(gh issue view:*)", "Bash(gh pr list:*)", "Bash(gh pr view:*)",
  "Bash(git log:*)", "Bash(git show:*)",
].join(",");

export type LaunchResult = { pid: number; logFile: string };

type Launch = {
  prompt: string;
  model: string;
  cwd: string;
  logFile: string;
  allowedTools: string;
  env: NodeJS.ProcessEnv;
};

/**
 * The whole reason this repo exists. The old dispatcher invoked claude synchronously, so a
 * tick blocked for the length of a Run and maxConcurrent bought nothing at all: three
 * "concurrent" Runs were three Runs one after another inside one very long tick. Here the
 * child is detached and unref'd, the tick returns in seconds, and concurrency is real.
 */
function spawnClaude(launch: Launch): LaunchResult {
  mkdirSync(dirname(launch.logFile), { recursive: true });
  const fd = openSync(launch.logFile, "a");

  const child = spawn(
    process.platform === "win32" ? "claude.exe" : "claude",
    [
      "-p", launch.prompt,
      "--model", launch.model,
      "--permission-mode", "acceptEdits",
      "--allowedTools", launch.allowedTools,
    ],
    {
      cwd: launch.cwd,
      env: launch.env,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    },
  );

  if (child.pid === undefined) throw new Error(`failed to launch claude in ${launch.cwd}`);
  child.unref();
  return { pid: child.pid, logFile: launch.logFile };
}

export function launchRun(
  config: Config,
  ticket: Ticket,
  worktree: string,
  branch: string,
  baseBranch: string,
  startedAt: Date = new Date(),
  // A Run sent back to fix a pull request gets its own prompt. Everything else about
  // launching it is identical, which is the point: a fix is a Run like any other, so it
  // is reaped, timed out and settled by exactly the same code.
  promptOverride?: string,
): LaunchResult {
  return spawnClaude({
    prompt: promptOverride ?? buildPrompt(ticket, branch, baseBranch),
    model: config.models[complexityOf(ticket.labels, config.defaultComplexity)],
    cwd: worktree,
    logFile: logPath(config.worktreeRoot, ticket.number, startedAt),
    allowedTools: ALLOWED_TOOLS,
    env: { ...process.env, ...loadRunSecrets(config.secretsDir, ticket.repo) },
  });
}

/**
 * Judgement is the whole job, so a Scout always gets the strongest model. It gets none of the
 * repo's secrets: it reads code and GitHub, and the gh login it needs is the server's own.
 */
export function launchScout(config: Config, repo: string, worktree: string, date: string, startedAt: Date): LaunchResult {
  return spawnClaude({
    prompt: buildScoutPrompt(repo, date),
    model: config.models.high,
    cwd: worktree,
    logFile: scoutLogPath(config.worktreeRoot, repo, startedAt),
    allowedTools: SCOUT_TOOLS,
    env: process.env,
  });
}

/**
 * Kills a Run and the tools it started. A detached child on Windows leads its own process
 * group, so taskkill /T is what actually reaches the npm and node processes underneath it;
 * killing the parent alone leaves those holding the worktree open and the removal fails.
 */
export function killRun(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone. Nothing to do.
  }
}
