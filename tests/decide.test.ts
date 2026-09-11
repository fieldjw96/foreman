import { describe, it, expect } from "vitest";
import { classifyRun, freeSlots, chooseTickets, outcomeOf } from "../src/decide.ts";
import type { LiveRun } from "../src/state.ts";
import type { Ticket } from "../src/gh.ts";

const run = (over: Partial<LiveRun> = {}): LiveRun => ({
  repo: "o/r", issue: 1, pid: 100, branch: "ticket/1",
  worktree: "C:/agent-runs/r/1", logFile: "x.log",
  startedAt: "2026-09-10T12:00:00.000Z", ...over,
});

const ticket = (number: number, labels: string[], blockedBy: number[] = []): Ticket => ({
  number, title: `t${number}`, labels, repo: "o/r", blockedBy,
});

describe("classifyRun", () => {
  it("calls a dead process finished regardless of age", () => {
    expect(classifyRun(run(), false, 45, new Date("2026-09-10T12:01:00Z"))).toBe("finished");
  });

  it("leaves a young live process alone", () => {
    expect(classifyRun(run(), true, 45, new Date("2026-09-10T12:30:00Z"))).toBe("alive");
  });

  // The concrete failure this replaces: a Run sat at status:running for six hours holding
  // the only slot, because nothing ever asked how old it was.
  it("times out a live process past the limit", () => {
    expect(classifyRun(run(), true, 45, new Date("2026-09-10T18:00:00Z"))).toBe("timed-out");
  });

  it("times out exactly at the boundary rather than one tick later", () => {
    expect(classifyRun(run(), true, 45, new Date("2026-09-10T12:45:00Z"))).toBe("timed-out");
  });
});

describe("freeSlots", () => {
  it("reports what is free", () => {
    expect(freeSlots(3, 1)).toBe(2);
  });

  it("never goes negative when more Runs are live than capacity allows", () => {
    expect(freeSlots(1, 3)).toBe(0);
  });
});

describe("chooseTickets", () => {
  it("takes only status:ready", () => {
    const picked = chooseTickets(
      [ticket(1, ["status:draft"]), ticket(2, ["status:ready"]), ticket(3, ["status:running"])],
      [], 5, "standard",
    );
    expect(picked.map((t) => t.number)).toEqual([2]);
  });

  it("respects the slot count", () => {
    const tickets = [1, 2, 3, 4].map((n) => ticket(n, ["status:ready"]));
    expect(chooseTickets(tickets, [], 2, "standard")).toHaveLength(2);
  });

  // A label edit that silently failed would otherwise put two Runs on one Ticket, both
  // writing to the same branch.
  it("skips a Ticket that already has a Run, even if its label still says ready", () => {
    const picked = chooseTickets(
      [ticket(1, ["status:ready"]), ticket(2, ["status:ready"])],
      [run({ issue: 1 })], 5, "standard",
    );
    expect(picked.map((t) => t.number)).toEqual([2]);
  });

  it("does not confuse the same issue number in two repos", () => {
    const other: Ticket = { ...ticket(1, ["status:ready"]), repo: "o/other" };
    const picked = chooseTickets([other], [run({ issue: 1, repo: "o/r" })], 5, "standard");
    expect(picked).toHaveLength(1);
  });

  it("starts the hardest work first, then lowest issue number", () => {
    const picked = chooseTickets(
      [
        ticket(1, ["status:ready", "complexity:low"]),
        ticket(2, ["status:ready", "complexity:high"]),
        ticket(3, ["status:ready", "complexity:standard"]),
        ticket(4, ["status:ready", "complexity:high"]),
      ],
      [], 4, "standard",
    );
    expect(picked.map((t) => t.number)).toEqual([2, 4, 3, 1]);
  });

  // The failure that prompted the rebuild: ordering used to be expressed by holding a
  // Ticket at draft, so a dependency waited on a human remembering to release it.
  it("skips a Ticket with an open blocker even though it is marked ready", () => {
    const picked = chooseTickets(
      [ticket(1, ["status:ready"], [99]), ticket(2, ["status:ready"])],
      [], 5, "standard",
    );
    expect(picked.map((t) => t.number)).toEqual([2]);
  });

  it("dispatches once the blocker is gone", () => {
    expect(chooseTickets([ticket(1, ["status:ready"], [])], [], 5, "standard")).toHaveLength(1);
  });

  it("returns nothing when there are no slots", () => {
    expect(chooseTickets([ticket(1, ["status:ready"])], [], 0, "standard")).toEqual([]);
  });
});

describe("outcomeOf", () => {
  it("sends a Run that opened a pull request to review", () => {
    expect(outcomeOf(42, 0, 2)).toBe("review");
  });

  it("retries a first failure", () => {
    expect(outcomeOf(null, 0, 2)).toBe("retry");
  });

  // The old harness re-ran bounced Tickets against a cause that had not changed, which is
  // how #7 and #50 burned their budget without ever getting closer.
  it("stops at the attempt limit instead of retrying for ever", () => {
    expect(outcomeOf(null, 1, 2)).toBe("needs-human");
  });

  it("never retries when the limit is one", () => {
    expect(outcomeOf(null, 0, 1)).toBe("needs-human");
  });
});
