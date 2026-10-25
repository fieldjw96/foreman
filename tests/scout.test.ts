import { describe, it, expect } from "vitest";
import {
  needsScout,
  parsePitches,
  pitchBody,
  pitchTitle,
  pitchMarker,
  expiredPitches,
  localDate,
  runName,
  PITCHES_START,
  PITCHES_END,
  type Pitch,
} from "../src/scout.ts";
import { chooseTickets } from "../src/decide.ts";
import type { ScoutRun, TicketRun } from "../src/state.ts";
import { PITCH_PICKED } from "../src/labels.ts";
import { scoutWorktreePath } from "../src/git.ts";

const scout = (over: Partial<ScoutRun> = {}): ScoutRun => ({
  kind: "scout", repo: "o/r", date: "2026-10-23", pid: 100,
  worktree: "C:/agent-runs/r/scout", logFile: "s.log",
  startedAt: "2026-10-23T08:00:00.000Z", ...over,
});

const ticketRun = (over: Partial<TicketRun> = {}): TicketRun => ({
  repo: "o/r", issue: 1, pid: 101, branch: "ticket/1",
  worktree: "C:/agent-runs/r/1", logFile: "t.log",
  startedAt: "2026-10-23T08:00:00.000Z", ...over,
});

const pitch = (over: Partial<Pitch> = {}): Pitch => ({
  title: "Hide companies past Series A from the Deck",
  kind: "fix",
  problem: "The Deck shows a company with a $50M Series A.",
  proposal: "Filter Profiles by funding stage at ingest.",
  evidence: "src/ingest/filter.ts has no stage check.",
  size: "small",
  ...over,
});

const output = (body: unknown, prose = "Here are today's Pitches.") =>
  `${prose}\n${PITCHES_START}\n${typeof body === "string" ? body : JSON.stringify(body)}\n${PITCHES_END}\n`;

describe("needsScout", () => {
  it("scouts a repo that has not been scouted today", () => {
    expect(needsScout("o/r", "2026-10-23", { "o/r": "2026-10-22" }, [])).toBe(true);
    expect(needsScout("o/r", "2026-10-23", {}, [])).toBe(true);
  });

  // The day is recorded at launch, so a Scout that failed is not relaunched every tick.
  it("does not scout a repo twice in one day, even if the first one failed", () => {
    expect(needsScout("o/r", "2026-10-23", { "o/r": "2026-10-23" }, [])).toBe(false);
  });

  it("does not start a second Scout while one is running, even across midnight", () => {
    expect(needsScout("o/r", "2026-10-24", { "o/r": "2026-10-23" }, [scout()])).toBe(false);
  });

  it("is not held up by a Ticket Run or another repo's Scout", () => {
    expect(needsScout("o/r", "2026-10-23", {}, [ticketRun(), scout({ repo: "o/other" })])).toBe(true);
  });
});

describe("parsePitches", () => {
  const three = [pitch(), pitch({ kind: "feature", size: "medium" }), pitch({ size: "large" })];

  it("reads three well-formed Pitches", () => {
    const parsed = parsePitches(output(three));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.pitches).toHaveLength(3);
  });

  it("takes the last marked block, so a draft followed by a revision yields the revision", () => {
    const draft = output([pitch({ title: "draft" }), pitch(), pitch()]);
    const final = output([pitch({ title: "final" }), pitch(), pitch()]);
    const parsed = parsePitches(draft + final);
    expect(parsed.ok && parsed.pitches[0]!.title).toBe("final");
  });

  it("rejects two or four, rather than filing a partial or padded day", () => {
    expect(parsePitches(output(three.slice(0, 2)))).toMatchObject({ ok: false, reason: expect.stringContaining("got 2") });
    expect(parsePitches(output([...three, pitch()]))).toMatchObject({ ok: false, reason: expect.stringContaining("got 4") });
  });

  it("rejects a Pitch with a missing or blank field", () => {
    const { evidence: _evidence, ...noEvidence } = pitch();
    expect(parsePitches(output([noEvidence, pitch(), pitch()]))).toMatchObject({ ok: false, reason: expect.stringContaining("evidence") });
    expect(parsePitches(output([pitch({ title: "  " }), pitch(), pitch()]))).toMatchObject({ ok: false });
  });

  it("rejects an unknown kind or size", () => {
    expect(parsePitches(output([{ ...pitch(), kind: "chore" }, pitch(), pitch()]))).toMatchObject({ ok: false });
    expect(parsePitches(output([{ ...pitch(), size: "huge" }, pitch(), pitch()]))).toMatchObject({ ok: false });
  });

  it("rejects bad JSON, a non-array, and output with no markers", () => {
    expect(parsePitches(output("[{ not json"))).toMatchObject({ ok: false, reason: expect.stringContaining("not JSON") });
    expect(parsePitches(output({ pitches: three }))).toMatchObject({ ok: false, reason: expect.stringContaining("array") });
    expect(parsePitches(JSON.stringify(three))).toMatchObject({ ok: false, reason: expect.stringContaining("no marked block") });
    expect(parsePitches("")).toMatchObject({ ok: false });
  });
});

describe("pitch issues", () => {
  it("carries the day's marker and every part of the Pitch", () => {
    const body = pitchBody(pitch(), "2026-10-23");
    expect(body.startsWith(pitchMarker("2026-10-23"))).toBe(true);
    for (const part of ["$50M Series A", "funding stage", "filter.ts", PITCH_PICKED]) {
      expect(body).toContain(part);
    }
  });

  it("is titled as a Pitch, so it never reads as a Ticket in a list", () => {
    expect(pitchTitle(pitch())).toBe("Pitch: Hide companies past Series A from the Deck");
  });
});

describe("expiredPitches", () => {
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9).toISOString();

  const now = new Date(2026, 9, 23, 0, 10);

  it("expires yesterday's undecided Pitches", () => {
    expect(expiredPitches([{ number: 5, labels: ["pitch"], createdAt: at(2026, 10, 22) }], "2026-10-23", now)).toEqual([5]);
  });

  it("keeps a picked Pitch however old it is", () => {
    expect(expiredPitches([{ number: 5, labels: ["pitch", PITCH_PICKED], createdAt: at(2026, 10, 1) }], "2026-10-23", now)).toEqual([]);
  });

  it("keeps today's Pitches", () => {
    expect(expiredPitches([{ number: 6, labels: ["pitch"], createdAt: at(2026, 10, 23) }], "2026-10-23", now)).toEqual([]);
  });

  // The first night: filed at 10pm, the next Scout ran just after midnight, and the set was
  // gone before morning.
  it("keeps a Pitch filed late yesterday until it has been open twelve hours", () => {
    const lateLastNight = new Date(2026, 9, 22, 22, 0).toISOString();
    const pitches = [{ number: 7, labels: ["pitch"], createdAt: lateLastNight }];
    expect(expiredPitches(pitches, "2026-10-23", now)).toEqual([]);
    expect(expiredPitches(pitches, "2026-10-24", new Date(2026, 9, 24, 0, 10))).toEqual([7]);
  });
});

describe("Scouts alongside Tickets", () => {
  // A Scout has no issue number. It must not make a Ticket look busy, or vice versa.
  it("does not stop a Ticket from being chosen", () => {
    const tickets = [{ number: 1, title: "t", labels: ["status:ready"], repo: "o/r", blockedBy: [] }];
    expect(chooseTickets(tickets, [scout()], 1, "standard")).toHaveLength(1);
  });

  it("names Runs by Ticket or by repo", () => {
    expect(runName(ticketRun())).toBe("o/r#1");
    expect(runName(scout())).toBe("o/r Scout");
  });

  it("gets one worktree per repo, apart from any Ticket's", () => {
    expect(scoutWorktreePath("C:/agent-runs", "o/rolodeck-ai")).toMatch(/rolodeck-ai[\\/]scout$/);
  });

  it("dates by the local calendar", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});
