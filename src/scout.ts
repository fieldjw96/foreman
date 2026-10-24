import type { LiveRun, ScoutRun, TicketRun } from "./state.ts";
import { PITCH_PICKED } from "./labels.ts";

/**
 * A Scout is a Run that reads a repo and suggests work instead of doing it. It files
 * nothing itself: it prints its Pitches between these markers as the last thing it says,
 * and the supervisor parses them, files them and enforces the count. A Run's own claim to
 * have filed three well-formed issues is the kind of say-so this system never trusts; a
 * parse that either succeeds or does not is.
 */
export const PITCHES_START = "<<<PITCHES";
export const PITCHES_END = "PITCHES>>>";
export const PITCHES_PER_DAY = 3;

export const PITCH_SIZES = ["small", "medium", "large"] as const;
export const PITCH_KINDS = ["fix", "feature"] as const;

export type Pitch = {
  title: string;
  kind: (typeof PITCH_KINDS)[number];
  problem: string;
  proposal: string;
  evidence: string;
  size: (typeof PITCH_SIZES)[number];
};

export type ParsedPitches = { ok: true; pitches: Pitch[] } | { ok: false; reason: string };

/** Marks a Pitch issue with the day it was filed, so a later Scout can find its history. */
export const pitchMarker = (date: string): string => `<!-- foreman:pitch ${date} -->`;

/**
 * The server's local calendar date. "Today" is Jack's day, not UTC's: a UTC date rolls over
 * at five in the afternoon Pacific, which would file tomorrow's Pitches before dinner.
 */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const isScout = (run: LiveRun): run is ScoutRun => run.kind === "scout";
export const isTicketRun = (run: LiveRun): run is TicketRun => run.kind !== "scout";

/** How a Run is named in logs: a Ticket by its number, a Scout by its repo. */
export const runName = (run: LiveRun): string =>
  isScout(run) ? `${run.repo} Scout` : `${run.repo}#${run.issue}`;

/**
 * One Scout per repo per day, and only one at a time. The day is recorded when a Scout
 * *launches*, not when it succeeds, so a Scout that keeps failing costs one attempt a day
 * rather than one every five minutes until the quota is gone.
 */
export function needsScout(
  repo: string,
  today: string,
  scouted: Record<string, string>,
  live: LiveRun[],
): boolean {
  if (scouted[repo] === today) return false;
  return !live.some((run) => isScout(run) && run.repo === repo);
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Reads the Pitches out of a Scout's output. The last marked block wins, because a Scout that
 * quotes its instructions back, or drafts and then revises, prints the markers more than once
 * and only the final one is its answer. Exactly three, or nothing: two is a Scout that gave
 * up, and four is one that was not listening, and neither should land on Jack's day.
 */
export function parsePitches(output: string): ParsedPitches {
  const end = output.lastIndexOf(PITCHES_END);
  const start = end === -1 ? -1 : output.lastIndexOf(PITCHES_START, end);
  if (start === -1 || end === -1) return { ok: false, reason: "no marked block of Pitches in the output" };

  let raw: unknown;
  try {
    raw = JSON.parse(output.slice(start + PITCHES_START.length, end).trim());
  } catch (err) {
    return { ok: false, reason: `the marked block is not JSON: ${(err as Error).message}` };
  }

  if (!Array.isArray(raw)) return { ok: false, reason: "the marked block is not a JSON array" };
  if (raw.length !== PITCHES_PER_DAY) {
    return { ok: false, reason: `expected ${PITCHES_PER_DAY} Pitches, got ${raw.length}` };
  }

  const pitches: Pitch[] = [];
  for (const [i, entry] of raw.entries()) {
    const p = (entry ?? {}) as Record<string, unknown>;
    for (const field of ["title", "problem", "proposal", "evidence"] as const) {
      if (!nonEmpty(p[field])) return { ok: false, reason: `Pitch ${i + 1} has no ${field}` };
    }
    if (!PITCH_KINDS.includes(p.kind as Pitch["kind"])) {
      return { ok: false, reason: `Pitch ${i + 1} kind must be one of ${PITCH_KINDS.join(", ")}` };
    }
    if (!PITCH_SIZES.includes(p.size as Pitch["size"])) {
      return { ok: false, reason: `Pitch ${i + 1} size must be one of ${PITCH_SIZES.join(", ")}` };
    }
    pitches.push({
      title: (p.title as string).trim(),
      kind: p.kind as Pitch["kind"],
      problem: (p.problem as string).trim(),
      proposal: (p.proposal as string).trim(),
      evidence: (p.evidence as string).trim(),
      size: p.size as Pitch["size"],
    });
  }
  return { ok: true, pitches };
}

export function pitchTitle(pitch: Pitch): string {
  return `Pitch: ${pitch.title}`;
}

export function pitchBody(pitch: Pitch, date: string): string {
  return [
    pitchMarker(date),
    `**${pitch.kind === "fix" ? "Fix" : "Feature"}**, ${pitch.size}. Proposed by the Scout on ${date}.`,
    "",
    "## Problem",
    "",
    pitch.problem,
    "",
    "## Proposal",
    "",
    pitch.proposal,
    "",
    "## Evidence",
    "",
    pitch.evidence,
    "",
    "---",
    "",
    `This is a Pitch, not a Ticket: foreman never builds it. Add \`${PITCH_PICKED}\` to keep it,`,
    "and it becomes a Ticket through `ticket-writer`. Close it as not planned to reject it,",
    "which is what the next Scout learns from. Left undecided, it is closed as expired when",
    "the next day's Pitches are filed.",
  ].join("\n");
}

export type OpenPitch = { number: number; labels: string[]; createdAt: string };

/**
 * The open Pitches that nobody decided on before today. They are closed when the new day's
 * Pitches land, so the backlog Jack faces is never more than one day deep. A picked Pitch is
 * waiting on a conversation, not on a decision, and is left alone.
 */
export function expiredPitches(open: OpenPitch[], today: string): number[] {
  return open
    .filter((p) => !p.labels.includes(PITCH_PICKED) && localDate(new Date(p.createdAt)) < today)
    .map((p) => p.number);
}

export const EXPIRED_COMMENT =
  "Expired: closed undecided when the next day's Pitches were filed. Reopen it to bring it back.";
