# foreman

foreman is an unattended supervisor that takes a labelled GitHub issue (a *Ticket*) and
drives it to a merged pull request. It dispatches coding agents, tracks their work through
review, sends them back when review or CI rejects the result, and stops at a human whenever
it runs out of things it is allowed to decide.

A Ticket's status label is the only durable state. There is no database and no queue
service, so GitHub and foreman cannot disagree about what is in flight.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture and, importantly, for the list of
capabilities deliberately left out. Most proposals for "one more safeguard" are already on
that list with a reason.

## How it works

A tick runs every five minutes and returns in seconds. It never waits on the work it
starts; agents run as detached processes and report success by opening a pull request, so
nothing here parses an exit code or scrapes a log.

Each tick, in order:

1. **Self-update.** Fast-forwards foreman's own clone to `main`, refusing a dirty or
   diverged tree. New code takes effect on the following tick.
2. **Reap.** Settles every Run whose process has exited, and kills any Run past
   `runTimeoutMinutes`. A Run that opened a pull request sends its Ticket to
   `status:review`; one that did not goes back to `status:ready`, or to
   `status:needs-human` once it is out of attempts.
3. **Maintain open pull requests.** Arms auto-merge, updates branches that have fallen
   behind their base, requests a fresh review when the code has moved past the last verdict,
   and comments on any pull request that has stopped moving with nothing coming for it.
4. **Dispatch fix Runs.** A pull request that is conflicting, red, or rejected by review
   gets an agent sent back to the same branch with the findings, the failing check log, and
   the conflict state in its prompt. Capped by `maxFixAttempts`.
5. **Claim new Tickets.** Fills any remaining slots from `status:ready`, hardest complexity
   first, lowest issue number breaking ties. Tickets with an open `blocked-by` relationship
   are skipped until it clears.

Finishing work outranks starting more of it: steps 3 and 4 run before step 5, so an open
pull request is never left to rot while new branches land on top of it.

## Ticket lifecycle

| Label | Meaning |
|---|---|
| `status:draft` | Still being written. Never dispatched. |
| `status:ready` | Dispatchable. |
| `status:running` | A Run holds it. |
| `status:review` | A pull request is open against it. |
| `status:needs-human` | Out of attempts. Nothing retries it. |

`complexity:low` / `complexity:standard` / `complexity:high` select which model the Run
uses. Absent that label, `defaultComplexity` applies.

## Commands

```
npm install
npm run tick        # run one tick
npm run status      # Runs in flight, with pids, ages and log paths
npm run stop        # kill every Run; the next tick settles their Tickets normally
npm test
npm run typecheck
```

No build step. Node 24 executes the TypeScript directly.

## Configuration

`foreman.config.json` at the repo root:

| Key | Meaning |
|---|---|
| `maxConcurrent` | Runs allowed in flight at once. |
| `runTimeoutMinutes` | A Run past this is killed and settled. |
| `maxAttempts` | Dispatches per Ticket before `status:needs-human`. |
| `maxFixAttempts` | Fix Runs per pull request before a human takes it. Default 3. |
| `gateReviewer` | Login whose review verdict and check count as the gate. Default `github-actions`. |
| `worktreeRoot` | Local disk root for worktrees, logs and process state. |
| `secretsDir` | Directory holding `<repo>.env` per repo. |
| `defaultComplexity` | Model tier for Tickets with no complexity label. |
| `models` | Model id per complexity tier. |
| `repos[]` | `name` (`owner/repo`), `clonePath`, optional `baseBranch` (default `main`). |

Paths may use `${VAR}` placeholders, resolved from the environment at load. Config is
validated on load rather than at first use, so a bad value fails immediately instead of on
the tick that needed it.

### Adding a repo

1. Add it to `repos`. **A repo missing from that array is never read, and nothing reports
   its Tickets as ignored.**
2. `.\scripts\setup-labels.ps1 -Repo "owner/name"` to create the label set.
3. Place its secrets at `<secretsDir>\<name>.env`.

## Installing the scheduler

```
.\scripts\install-task.ps1     # -Unregister to remove
```

Registers a Windows scheduled task that ticks every five minutes. Install it on exactly one
host: the one holding the `claude` and `gh` logins and the secrets. A tick takes a lock
under `worktreeRoot`, so overlapping ticks are harmless, but two hosts dispatching the same
Tickets is not.

## Invariants

These are load-bearing, not preferences.

- **Agents never merge.** A Run opens a pull request; merging is gated on review and CI,
  and a human owns anything that stalls.
- **Secrets never enter synced storage.** They live under `secretsDir` and reach a Run as
  environment variables on its own process. Nothing is written into a worktree, so no agent
  can commit one.
- **Runs never work inside synced storage.** Worktrees, logs and state go under
  `worktreeRoot` on local disk. Build output and `node_modules` must never reach sync.
- **Branch work happens in a worktree, never in the canonical clone.** A `git checkout` in
  a synced clone changes what every other machine sees.
- **No hardcoded user paths.** Use `${VAR}` placeholders; hosts do not share a profile name.

## Layout

- `src/decide.ts`, `src/fix.ts`, `src/rereview.ts` hold the decisions as pure functions.
  New logic belongs here, with a test, not in the orchestration.
- `src/tick.ts` is the only module that sequences side effects.
- `src/gh.ts` is the only module that shells out to `gh`, always with an argv array.
- `skills/ticket-writer` is the skill for writing Tickets foreman can dispatch.
