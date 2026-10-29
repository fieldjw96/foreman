import type { Announcement } from "./decide.ts";

/**
 * Telling jack-field's Kitchen that a Scout is at work.
 *
 * A Scout leaves no trace on GitHub while it runs: it claims no Ticket, sets no
 * status:running and opens no pull request, and its Pitches appear only once it has
 * finished. foreman is therefore the only thing that knows one exists, which is why this
 * is the one place foreman reaches out to a product site at all.
 *
 * Nothing here may ever affect a Run or a tick. Every call resolves, never rejects, and
 * returns a short reason instead of throwing so the caller can log it and carry on. The
 * TTL remains the mechanism exactly as jack-field's ADR 0001 requires: a missed end is a
 * Shift that expires on its own a little later, not a Shift that never ends.
 */

/** The Hand jack-field draws for a Scout. Its word, not foreman's: see the Ticket. */
export const PRODUCT_HAND = "product";

/** Matches the heartbeat script jack-field ships, for the same reason: a tick is not a place to wait. */
const TIMEOUT_MS = 4000;

type Fetch = typeof fetch;

async function post(
  announcement: Announcement,
  body: Record<string, unknown>,
  fetchImpl: Fetch,
): Promise<string | null> {
  if (!announcement.announce) return announcement.why;
  try {
    const res = await fetchImpl(`${announcement.url}/api/presence`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${announcement.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? null : `the Kitchen answered ${res.status}`;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Announces that a Scout has started on `repo`. Resolves with null on success. */
export function announceScout(
  announcement: Announcement,
  doing: string,
  repo: string,
  ttlSeconds: number,
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  return post(
    announcement,
    { hand: PRODUCT_HAND, doing, repo: repo.split("/")[1] ?? repo, ttlSeconds },
    fetchImpl,
  );
}

/**
 * Ends the Shift, whatever became of the Scout. Called on every outcome, because a Scout
 * that failed has stopped working just as surely as one that filed three Pitches.
 */
export function endScoutShift(
  announcement: Announcement,
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  return post(announcement, { hand: PRODUCT_HAND, end: true }, fetchImpl);
}
