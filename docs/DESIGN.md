# What went wrong, and what this does instead

`agent-harness` ran for weeks and did genuinely build a working application. It is being
replaced rather than repaired because almost all of its complexity existed to compensate
for a single architectural mistake, and no amount of repair reaches that.

This document is the reason the replacement is small. Read it before adding anything.

## The root cause

**The dispatcher invoked `claude` synchronously.** One call, blocking, in the middle of the
tick. Everything below follows from that one line.

Because a tick blocked for the length of a Run:

- `maxConcurrent` bought nothing. The claim loop was a `foreach` over free slots inside one
  tick, so three "concurrent" Runs were three Runs one after another. Raising rolodeck-ai
  from 1 to 3 tripled the length of a tick and the window in which nothing else could
  happen. It was raised, then reverted the same day.
- A tick could last hours, so the scheduled task needed `ExecutionTimeLimit PT4H` and
  `MultipleInstances: IgnoreNew`.
- That needed a global lock, which needed a staleness check, which could only run inside a
  tick, which is the one thing that was not happening while a tick was stuck.
- A killed Run held its slot for ever, because nothing outside the blocked tick could
  notice. One Ticket sat at `status:running` for six hours holding the only slot.
- Nothing could see that the queue had stalled, so a stall alarm was added, which summoned a
  Warden, which filed a report, which cleared the alarm, which re-armed it. Thirty-odd
  reports, several of them about the Warden.

**The fix is four lines**: `detached: true`, a log file descriptor, `child.unref()`, and a
state file holding process ids across ticks. A tick now takes seconds. Concurrency is real.
A hung Run is a process with a start time, so a timeout is a subtraction.

## What was dropped, and why

**The Warden.** A judgement agent summoned when the queue looked stuck. It could not act, so
it wrote reports; writing one cleared the stall alarm that summoned it, so it summoned
itself. With ticks that are seconds long and timeouts that are arithmetic, there is no stall
left for it to interpret.

**The prerequisite classifier.** It read backtick spans in a Ticket body and refused to
dispatch when it decided a tool, credential or path was missing. It produced six false
refusals, each of which looked exactly like an idle queue. It was narrowed twice and finally
amended to "err towards dispatching", which is to say: turned off in all but name. A Run
that starts and reports a missing dependency is strictly better than a Run that never
starts and reports nothing.

**Bounce retries.** Two counters, `maxBounces` and `maxBouncedRetries`, that re-ran a Ticket
whose cause "had plausibly changed". They re-ran work against unchanged causes and left two
pull requests conflicting against a main branch that had moved twice. There is now one
number, `maxAttempts`, and the end of it is a human.

**Blockers expressed as `status:draft`.** A Ticket held at draft depends on a person
remembering to release it. Two were held for two days, starving the queue, which is the
failure that prompted the rebuild. `gh` is now 2.98.0 and supports `--blocked-by`, so if
blockers come back they come back as GitHub's own, not as a label convention.

**Auto-merge, and the protected-path list that guarded it.** Agents never merge.

**PowerShell.** Not a matter of taste. Windows PowerShell 5.1 caused most of the outages
directly: native argument quote splitting, `$OFS` joining arrays in string interpolation,
`-match` being case-insensitive, `2>&1` throwing under `Stop`, and `return ,@()` coming back
from `@(f())` as one element holding an array. That last one produced eight false test
failures against correct code, twice. TypeScript is the language the products are written in
and the one a reader can actually check.

## What was kept

- **Tickets with machine-checkable acceptance criteria.** The `ticket-writer` skill is
  carried over unchanged. It is the highest-value part of the old system by a wide margin:
  the quality of a Run is set almost entirely by the quality of its Ticket.
- **Worktree isolation on local disk.** Correct, and the hard rules about OneDrive stand.
- **Secrets outside OneDrive, injected per-process.** Correct.
- **Humans merge.** Correct.
- **Complexity maps to a model in config, not on the Ticket.** A new model release is one
  config change rather than a relabelling of every Ticket.

## Decisions worth stating

**The Run opens its own pull request.** The supervisor could push and open it instead, but
then it would need to know whether the work was finished, which means parsing an exit code
or reading a log. A pull request on the branch is an unambiguous signal that costs one API
call. Exit codes lie; a pull request does not.

**GitHub is the only durable state.** No database. Every local store the old system kept
eventually disagreed with GitHub and had to be reconciled by hand. The local state file
holds process ids, which are meaningless anywhere else and worthless after a reboot, so
losing it is cheap by construction.

**There is a lock, and it is not the old one.** Two ticks running at once would both read
the same state, both see free slots, and both claim the same Ticket. The scheduled task's
`IgnoreNew` only covers the scheduled case; a person running `npm run tick` by hand races it,
which happened during bring-up and was how this was found.

The difference from the lock that was dropped is what decides staleness. The old one recorded
a timestamp and treated a lock older than two hours as abandoned, and could only evaluate that
from inside a tick, which was exactly the thing that was stuck. This one records a pid: if the
holder's process is gone the lock is meaningless, whether it was taken two seconds ago or last
week. That is a fact, not a heuristic, and it needs no timeout to tune.

**The tick claims before it creates a worktree.** If the claim fails, nothing has been
created and the next tick simply tries again.

**Runs are excluded from the queue by issue number, not by label.** A label edit that failed
to stick would otherwise start a second Run on a Ticket that already has one, both pushing
to the same branch.

**A Run pushes before it verifies, and still opens the pull request last.** The prompt used
to say to get the repo's checks passing before pushing. That is what a person does, and it is
wrong here: a Run is stopped mid-command when its time is up and its worktree is removed, so
work committed nowhere but locally goes with it and leaves no trace. rolodeck-ai#156 was lost
twice this way inside an hour. Both Runs had finished the work, both were waiting on a suite
CI was going to run anyway, neither had pushed, and the Ticket reached `status:needs-human`
with two Runs' output unrecoverable.

Pushing early is safe precisely because a pushed branch is not the finish signal. Opening the
pull request is, so that stays last: an early one would tell the supervisor a Run had finished
while it was still working, and it would stop watching. The prompt now also tells a Run to
leave browser and end-to-end suites to CI, which is the authority on them and already routes a
red one back as a fix Run. Running them locally as well buys nothing, and it is what both lost
Runs were doing when they died.

**A waiting pull request that stops moving gets said out loud, and is not diagnosed.** Of the
three states a pull request can be in, two look after themselves: `needs-fix` gets a fix Run,
`ready-to-merge` merges. `waiting` means "something is expected to happen" and nothing checked
that it ever did, so both deadlocks so far lived there. rolodeck-ai#167 and #168 sat approved,
green, mergeable and unmergeable overnight, and surfaced only because a person asked whether
anything needed attention.

It reports rather than diagnoses, deliberately. A pull request blocked on a code owner's
approval is indistinguishable from here from one blocked on a check nobody will ever post, and
GitHub does not cleanly separate them. Telling them apart would mean a classifier that is
wrong sometimes and trusted always; stating what is observed leaves the judgement with the
person who can make it. A pull request that has been waiting on Jack for three hours deserves
a nudge anyway, so that case is the feature rather than a false positive.

Three hours is a constant in code with its derivation beside it, not a config knob, because
the question it answers is "when does waiting stop being normal" rather than "which bug is
this hiding". Nothing is stored: quiet is measured from the newest thing that already happened
to the pull request, which keeps GitHub the only durable state, and foreman finds its own
previous report by a marker comment the same way it already finds its fix Runs.

## The constraint that shapes everything

JACK_LAPTOP and the server laptop cannot reach each other. Anything the server needs arrives
through OneDrive or through GitHub. The server holds the scheduled task, the `claude` and
`gh` logins, and the secrets.

## The limit that is not technical

Concurrent Runs all draw on the same Claude subscription window. Three in parallel exhaust
it roughly three times faster. The practical ceiling on `maxConcurrent` is the plan, not the
machine, and it is closer to 3 than to 20.
