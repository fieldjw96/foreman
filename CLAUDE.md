# foreman

The supervisor that turns a GitHub Ticket into a pull request, unattended.

Read [docs/DESIGN.md](docs/DESIGN.md) before adding anything. It records what the previous
system got wrong and what was deliberately dropped, and most ideas for "one more safeguard"
are already in the dropped list with a reason.

## The shape

One tick: reap dead Runs, count free slots, claim that many `status:ready` Tickets, launch
each as a **detached** process, return. A tick takes seconds. It never waits for a Run.

- `src/decide.ts` holds every decision as a pure function. New logic belongs here, with a
  test, not inside the orchestration.
- `src/tick.ts` is the only place with side effects in sequence.
- `src/gh.ts` is the only place that shells out to `gh`, always as an argv array.

## Rules that do not bend

- **Agents never merge.** A Run opens a pull request and Jack decides.
- **Secrets never enter OneDrive.** Not in a `.env`, not in a script, not temporarily. They
  live under `C:\agent-secrets` and reach a Run as environment variables on its process
  only. Nothing is written into a worktree, so no agent can commit one.
- **Runs never work inside OneDrive.** Worktrees go under `C:\agent-runs` on local disk.
  Build output and `node_modules` must never reach sync.
- **Never hardcode a user profile path.** Use `${OneDrive}` in config, resolved at runtime.
  The two laptops do not share a profile name.
- **A repo must be in `repos` in `foreman.config.json`** or its Tickets sit for ever.
- **`git checkout` in a clone under OneDrive changes what the other laptop sees.** Branch
  work happens in a worktree, never in the canonical clone.

## The two machines

- **JACK_LAPTOP**: conversation, design, ticket writing. No scheduled task, no Runs.
- **The server laptop**: always on. Holds the scheduled task, the `claude` and `gh` logins,
  and the secrets.

Neither can reach the other. Anything the server needs arrives through OneDrive or GitHub.

## Before you add a knob

The config this replaced had nine tuning numbers, each one added to compensate for a bug,
and comments longer than the values. If a new number seems necessary, the question is which
bug it is hiding.
