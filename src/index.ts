import { loadConfig } from "./config.ts";
import { tick } from "./tick.ts";
import { readState, statePath, isProcessAlive, ageMinutes } from "./state.ts";
import { killRun } from "./launch.ts";

const command = process.argv[2] ?? "tick";
const config = loadConfig();
const path = statePath(config.worktreeRoot);

switch (command) {
  case "tick": {
    await tick(config);
    break;
  }

  case "status": {
    const { runs } = readState(path);
    if (runs.length === 0) {
      console.log(`no Runs in flight (capacity ${config.maxConcurrent})`);
      break;
    }
    console.log(`${runs.length} of ${config.maxConcurrent} slots in use`);
    for (const run of runs) {
      const alive = isProcessAlive(run.pid) ? "alive" : "DEAD, will settle next tick";
      console.log(
        `  ${run.repo}#${run.issue}  pid ${run.pid}  ${ageMinutes(run.startedAt).toFixed(0)}m  ${alive}`,
      );
      console.log(`    log: ${run.logFile}`);
    }
    break;
  }

  // Kills every Run in flight but leaves their Tickets alone. The next tick settles them
  // normally, so a stop is never a state the system has to be rescued from.
  case "stop": {
    const { runs } = readState(path);
    for (const run of runs) {
      killRun(run.pid);
      console.log(`killed #${run.issue} (pid ${run.pid})`);
    }
    console.log(`${runs.length} Run(s) killed. Run a tick to settle their Tickets.`);
    break;
  }

  default:
    console.error(`unknown command "${command}". Use: tick | status | stop`);
    process.exit(2);
}
