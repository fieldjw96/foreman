import type { Complexity } from "./config.ts";

/**
 * The Ticket's labels are the only durable state in this system. There is no database and
 * no lock file, because every one of those the old harness had eventually disagreed with
 * GitHub and had to be reconciled by hand.
 */
export const STATUS = {
  draft: "status:draft",
  ready: "status:ready",
  running: "status:running",
  review: "status:review",
  needsHuman: "status:needs-human",
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

export const ALL_STATUSES: Status[] = Object.values(STATUS);

export function statusOf(labels: string[]): Status | null {
  return ALL_STATUSES.find((s) => labels.includes(s)) ?? null;
}

export function complexityOf(labels: string[], fallback: Complexity): Complexity {
  if (labels.includes("complexity:high")) return "high";
  if (labels.includes("complexity:low")) return "low";
  if (labels.includes("complexity:standard")) return "standard";
  return fallback;
}

/** A Ticket is dispatchable only at status:ready. draft means a human is still writing it. */
export function isDispatchable(labels: string[]): boolean {
  return statusOf(labels) === STATUS.ready;
}
