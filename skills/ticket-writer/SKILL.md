---
description: Turn a conversation about a feature, bug or chore into a GitHub issue with machine-checkable acceptance criteria and a routing lane. Use when the user wants to write, file, create or raise a ticket or issue, or when a discussion has settled into work worth capturing.
---

# Ticket Writer

Turn a conversation into one Ticket a coding agent can complete unsupervised.

The value here is not the `gh` invocation. It is refusing to file work that is not ready.
An underspecified Ticket does not fail loudly; it produces a plausible pull request that
solves the wrong problem, and the cost lands on Jack at review time.

## Before writing anything

Read the target repo's `CONTEXT.md` if it has one, and use its terms. If the conversation
has been using a word the glossary defines differently, say so rather than quietly
translating.

Check the repo's `docs/` for a decision that constrains this work. A Ticket that contradicts
a recorded decision is either wrong, or is a request to supersede it, and those are very
different Tickets.

Check whether the thing the Ticket describes already exists. A Ticket that names something
it intends to create goes stale the moment another Ticket creates it, and nothing checks for
that. It has already happened once: a nav Ticket sat at draft while an unrelated Run built
the nav.

## The bar

**Acceptance Criteria must be machine-checkable.** This is the whole skill. A criterion is
machine-checkable when you could write the assertion that proves it without asking anyone
what they meant.

Not acceptable:

- "Handles pagination properly"
- "The UI feels responsive"
- "Errors are handled gracefully"

Acceptable:

- "GET /companies?cursor=X returns at most 50 items plus a next_cursor; tests cover the
  empty, partial and final page"
- "First contentful paint under 1.5s on a simulated 4G profile in the Playwright run"
- "A malformed upstream payload is rejected by the Zod schema at the boundary and logged
  with the offending field name; the request returns 422 rather than throwing"

If you cannot write the criteria this way, the Ticket is not ready. Say which part is
still fuzzy and ask about that specific part. Do not file it with a softer criterion, and
do not invent a measurable number nobody agreed to. If it cannot be made checkable because
it needs Jack's taste, say so plainly: that is work for a human, not a Ticket.

## The final criterion must mirror CI exactly

Every Ticket ends with a criterion listing the commands that must exit 0. **Read the repo's
CI workflow and list exactly what it runs, in its order.** Do not write that list from
memory and do not carry it over from an older Ticket.

A Run satisfies the Acceptance Criteria it was given. If CI runs a check the Ticket did not
name, the Run can meet every criterion in full and still fail, and the Ticket is what was
wrong. This has already happened: rolodeck-ai#120 listed typecheck, lint, test and build,
CI also ran `format:check`, and the Run failed on formatting it was never asked to check.

Where a check is known to be noisy locally, say so in the criterion and say what to do
about it, or the Run will either ignore a real failure or try to fix the noise.

## Do not enumerate a set another Ticket can grow

Naming the members of a set dates the Ticket the moment another Ticket adds one. Prefer the
rule that selects them: "every Source under `lib/ingest/`" rather than a list of four
Sources by name.

This is the same failure as naming the thing a Ticket creates, and it has also already
happened: rolodeck-ai#120 named four Sources to map, #50 added two more while #120 was
running, and 13 tests failed against the merge on Sources the Run was never told about.

When an enumeration is genuinely necessary, add the rule as well, so a Run that finds a
member the Ticket did not list knows it is in scope rather than guessing.

## Choosing the Lane

- `lane:claude` when the work depends on Skills, `CLAUDE.md`, subagents, MCP servers,
  browser verification, or any judgement call. Rerouting these does not delay the work, it
  silently changes what gets built.
- `lane:any` when the Ticket is specified tightly enough that any competent agent produces
  the same result: a migration, a test backfill, a rename, a dependency bump, a bounded
  endpoint.

When in doubt, `lane:claude`. A Ticket you cannot honestly label `lane:any` is usually one
that is not written well enough yet, and noticing that is the point.

## Choosing the Complexity

Complexity decides which model runs the Ticket. It is not size and it is not importance: a
thousand-line rename is mechanical, and a forty-line change to an auth boundary is not.

- `complexity:high` when the Ticket needs design judgement, touches an area with real blast
  radius (auth, money, data loss, migrations), or works on ground the codebase has not
  covered before.
- `complexity:standard` for ordinary feature work against a clear spec. This is the default
  and most Tickets belong here.
- `complexity:low` for mechanical work: renames, dependency bumps, test backfills, config,
  anything where the change is obvious once described.

Bias upward when unsure. A cheaper model that gets bounced twice costs more quota than the
right model once, and it costs Jack two review cycles as well.

## Size

There is no cap on diff size. Still say so when a Ticket looks like it will produce a very
large diff, because that is normally evidence it should be split, and split Tickets can run
concurrently.

## Blockers

If this work cannot start until another Ticket lands, record it with
`gh issue edit <n> --add-blocked-by <m>`. foreman reads GitHub's own blocker relationship
and will not dispatch a Ticket with an open blocker, whatever its status label says.

Never express ordering by holding a Ticket at `status:draft` instead. That was the old
convention and it depends on a person remembering to release it; two Tickets were forgotten
for two days and starved the queue. `status:draft` means "not finished being written", and
nothing else.

If the work is one piece of something larger, make it a sub-issue of the parent rather
than inventing an epic label.

## Filing it

Confirm the assembled Ticket with Jack before filing, then create it with `gh issue
create`, passing the repo, an imperative and specific title, the labels (a `lane:` and a
`status:`), and the body from a file.

Body sections, in order: **Goal** (one or two sentences on why, not how), **Acceptance
Criteria** (a checklist, every line machine-checkable), **Out of Scope** (what an agent
must not touch; this is what stops scope creep), **Notes** (links, prior art, the decision that
constrains it).

Report the issue number and URL. Do not set `status:ready` on a Ticket still waiting on an
answer from Jack; use `status:draft` so the dispatcher leaves it alone.
