import type { Ticket } from "./gh.ts";
import type { LiveRun } from "./state.ts";
import { ageMinutes } from "./state.ts";
import { isTicketRun } from "./scout.ts";
import { isDispatchable, complexityOf } from "./labels.ts";
import type { Complexity } from "./config.ts";

export type RunVerdict = "alive" | "finished" | "timed-out";

/**
 * A Run is finished when its process is gone. Whether it *succeeded* is a separate
 * question answered by GitHub, not by this function.
 */
export function classifyRun(
  run: LiveRun,
  alive: boolean,
  timeoutMinutes: number,
  now: Date = new Date(),
): RunVerdict {
  if (!alive) return "finished";
  return ageMinutes(run.startedAt, now) >= timeoutMinutes ? "timed-out" : "alive";
}

export function freeSlots(maxConcurrent: number, liveCount: number): number {
  return Math.max(0, maxConcurrent - liveCount);
}

const ORDER: Record<Complexity, number> = { high: 0, standard: 1, low: 2 };

/**
 * A Ticket with an open blocker is not ready, whatever its status label says. This is
 * GitHub's own relationship, set with `gh issue edit --add-blocked-by`. The old harness had
 * no way to read it and expressed ordering by holding a Ticket at status:draft instead,
 * which meant every dependency waited on a human remembering to release it. Two of them
 * were forgotten for two days and starved the queue.
 */
export function blockersOpen(ticket: Ticket): boolean {
  return ticket.blockedBy.length > 0;
}

/**
 * Picks what to start. Tickets already being run are excluded by number, not by label,
 * because a label edit that failed to stick would otherwise start a second Run on a Ticket
 * that already has one. Ordering is hardest-first so the long Runs get going early, and
 * lowest issue number breaks ties so the queue drains in the order it was written.
 */
export function chooseTickets(
  tickets: Ticket[],
  live: LiveRun[],
  slots: number,
  defaultComplexity: Complexity,
): Ticket[] {
  const busy = new Set(live.filter(isTicketRun).map((r) => `${r.repo}#${r.issue}`));
  return tickets
    .filter((t) => isDispatchable(t.labels) && !blockersOpen(t) && !busy.has(`${t.repo}#${t.number}`))
    .sort((a, b) => {
      const byComplexity =
        ORDER[complexityOf(a.labels, defaultComplexity)] - ORDER[complexityOf(b.labels, defaultComplexity)];
      return byComplexity !== 0 ? byComplexity : a.number - b.number;
    })
    .slice(0, slots);
}

/**
 * What to do with a Run that has ended. A pull request means it did its job. No pull
 * request means it did not, and it goes back in the queue until it has burned its
 * attempts, at which point it stops and waits for a human instead of retrying for ever.
 */
export function outcomeOf(
  pullRequest: number | null,
  priorFailures: number,
  maxAttempts: number,
): "review" | "retry" | "needs-human" {
  if (pullRequest !== null) return "review";
  return priorFailures + 1 >= maxAttempts ? "needs-human" : "retry";
}

/**
 * Whether a Scout may announce itself to jack-field's Kitchen, and with what.
 *
 * Read from foreman's own environment and nowhere else: an announcement is foreman
 * speaking, not a Run, so `loadRunSecrets` and the worktree have no part in it.
 *
 * With either value missing foreman stays silent rather than guessing a URL.
 * jack-field.com redirects the apex to www, and fetch drops the Authorization header
 * across that change of origin, so a guessed default would be rejected on every beat and
 * the only symptom would be a Hand that never wakes.
 */
export type Announcement =
  | { announce: false; why: string }
  | { announce: true; url: string; token: string };

export function announcementFor(env: NodeJS.ProcessEnv): Announcement {
  const url = env.JACK_FIELD_URL?.trim();
  const token = env.PRESENCE_TOKEN?.trim();
  if (!url && !token) return { announce: false, why: "JACK_FIELD_URL and PRESENCE_TOKEN are unset" };
  if (!url) return { announce: false, why: "JACK_FIELD_URL is unset" };
  if (!token) return { announce: false, why: "PRESENCE_TOKEN is unset" };
  return { announce: true, url: url.replace(/\/+$/, ""), token };
}

/**
 * A Shift should never outlast the Run it describes. The Kitchen's own schema accepts
 * thirty seconds to an hour, so a longer timeout is clamped rather than rejected.
 */
export function announceTtlSeconds(runTimeoutMinutes: number): number {
  return Math.min(3600, Math.max(30, Math.round(runTimeoutMinutes * 60)));
}

/** The line shown under the character. Capped because the Kitchen rejects a longer one. */
export function scoutDoing(repo: string): string {
  return `Scouting ${repo.split("/")[1] ?? repo}`.slice(0, 60);
}
