import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Ticket } from "./gh.ts";
import { loadRunSecrets } from "./secrets.ts";
import { buildPrompt } from "./prompt.ts";
import { complexityOf } from "./labels.ts";

export const ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "TodoWrite", "Task",
  "Bash", "PowerShell",
].join(",");

export function logPath(worktreeRoot: string, issue: number, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return join(worktreeRoot, "logs", `ticket-${issue}-${stamp}.log`);
}

export type LaunchResult = { pid: number; logFile: string };

/**
 * The whole reason this repo exists. The old dispatcher invoked claude synchronously, so a
 * tick blocked for the length of a Run and maxConcurrent bought nothing at all: three
 * "concurrent" Runs were three Runs one after another inside one very long tick. Here the
 * child is detached and unref'd, the tick returns in seconds, and concurrency is real.
 */
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
  const model = config.models[complexityOf(ticket.labels, config.defaultComplexity)];
  const logFile = logPath(config.worktreeRoot, ticket.number, startedAt);
  mkdirSync(join(config.worktreeRoot, "logs"), { recursive: true });
  const fd = openSync(logFile, "a");

  const child = spawn(
    process.platform === "win32" ? "claude.exe" : "claude",
    [
      "-p", promptOverride ?? buildPrompt(ticket, branch, baseBranch),
      "--model", model,
      "--permission-mode", "acceptEdits",
      "--allowedTools", ALLOWED_TOOLS,
    ],
    {
      cwd: worktree,
      env: { ...process.env, ...loadRunSecrets(config.secretsDir, ticket.repo) },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    },
  );

  if (child.pid === undefined) throw new Error(`failed to launch a Run for #${ticket.number}`);
  child.unref();
  return { pid: child.pid, logFile };
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
