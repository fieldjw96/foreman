import { describe, it, expect } from "vitest";
import { pickFreshPullRequest } from "../src/gh.ts";

const started = new Date("2026-09-10T18:13:40Z");

describe("pickFreshPullRequest", () => {
  it("takes a pull request touched after the Run began", () => {
    expect(pickFreshPullRequest([{ number: 120, updatedAt: "2026-09-10T18:40:00Z" }], started)).toBe(120);
  });

  /**
   * The bug this was written for. A Ticket that has been run before usually has an old pull
   * request on its branch, and a closed one was matching, so a Run that did nothing at all
   * was recorded as a success and sent to review. Found against real data: ticket/7 returned
   * PR 56, closed hours earlier, while the Run on #7 was still in flight.
   */
  it("ignores a pull request last touched before the Run began", () => {
    expect(pickFreshPullRequest([{ number: 56, updatedAt: "2026-09-10T01:00:00Z" }], started)).toBeNull();
  });

  it("takes the newest when a stale and a fresh one are both open", () => {
    expect(pickFreshPullRequest(
      [
        { number: 56, updatedAt: "2026-09-10T01:00:00Z" },
        { number: 120, updatedAt: "2026-09-10T18:40:00Z" },
      ],
      started,
    )).toBe(120);
  });

  // A Run that pushed commits to a pull request that already existed did the work, even
  // though it opened nothing.
  it("counts an existing pull request the Run pushed to", () => {
    expect(pickFreshPullRequest([{ number: 99, updatedAt: "2026-09-10T18:50:00Z" }], started)).toBe(99);
  });

  it("returns null when the branch has none", () => {
    expect(pickFreshPullRequest([], started)).toBeNull();
  });

  it("skips the freshness check when no start time is given", () => {
    expect(pickFreshPullRequest([{ number: 56, updatedAt: "2020-01-01T00:00:00Z" }])).toBe(56);
  });

  it("accepts one updated at exactly the start instant", () => {
    expect(pickFreshPullRequest([{ number: 7, updatedAt: started.toISOString() }], started)).toBe(7);
  });
});
