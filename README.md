# foreman

Turns a GitHub Ticket into a pull request, unattended, on the always-on laptop.

It replaces `agent-harness`, which worked but grew to 4,366 lines of PowerShell and spent
most of its complexity compensating for one architectural mistake. See
[docs/DESIGN.md](docs/DESIGN.md) for what was learned and what was deliberately dropped.

## What it does

Every five minutes a tick runs. It:

1. **Reaps.** For each Run in flight, checks whether its process is still alive. A dead one
   is settled: if a pull request exists on its branch the Ticket goes to `status:review`,
   otherwise it goes back to `status:ready` until it runs out of attempts. A live one past
   `runTimeoutMinutes` is killed and settled the same way.
2. **Claims.** Counts free slots, takes that many `status:ready` Tickets, hardest first.
3. **Launches.** Creates a worktree on local disk and starts `claude -p` **detached**, then
   returns. A tick takes seconds, never the length of a Run.

The agent opens its own pull request. That is the success signal, so nothing here parses an
exit code or scrapes a log.

## Running it

```
npm install
npm run tick      # one tick
npm run status    # what is in flight right now
npm run stop      # kill every Run; the next tick settles their Tickets
npm test
npm run typecheck
```

No build step. Node 24 runs the TypeScript directly.

## Setting up a new repo

1. Add it to `repos` in `foreman.config.json`. **A repo missing from that array has its
   Tickets sit for ever and nothing ever says why.**
2. `.\scripts\setup-labels.ps1 -Repo "owner/name"`
3. Put its secrets at `C:\agent-secrets\<name>.env`, never in OneDrive.

## Installing on the server laptop

```
.\scripts\install-task.ps1
```

Registers a scheduled task that ticks every five minutes. `-Unregister` removes it.

## The state model

A Ticket's label is the only durable state:

| Label | Meaning |
|---|---|
| `status:draft` | A human is still writing it. Never dispatched. |
| `status:ready` | Dispatchable. |
| `status:running` | A Run has it. |
| `status:review` | A pull request is open. A human decides. |
| `status:needs-human` | Out of attempts. Nothing retries it. |

`foreman-state.json` under `C:\agent-runs` holds process ids and nothing else. It is local,
disposable, and losing it costs one reconciliation pass, never a Ticket.

## Rules that do not bend

- **Agents never merge.** A Run opens a pull request and Jack decides.
- **Secrets never enter OneDrive.** They live under `C:\agent-secrets` and are passed to a
  Run as environment variables on its process only.
- **Runs never work inside OneDrive.** Worktrees go under `C:\agent-runs` on local disk.
- **Never hardcode a user profile path.** Config uses `${OneDrive}`, resolved at runtime,
  because the two laptops do not share a profile name.
