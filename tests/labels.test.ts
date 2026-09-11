import { describe, it, expect } from "vitest";
import { statusOf, complexityOf, isDispatchable, STATUS } from "../src/labels.ts";

describe("statusOf", () => {
  it("finds the status label", () => {
    expect(statusOf(["lane:claude", "status:ready"])).toBe(STATUS.ready);
  });

  it("returns null when a Ticket carries no status at all", () => {
    expect(statusOf(["lane:claude"])).toBeNull();
  });
});

describe("complexityOf", () => {
  it("reads the label when present", () => {
    expect(complexityOf(["complexity:high"], "standard")).toBe("high");
  });

  it("falls back when absent", () => {
    expect(complexityOf(["lane:claude"], "standard")).toBe("standard");
  });
});

describe("isDispatchable", () => {
  it("dispatches ready", () => {
    expect(isDispatchable(["status:ready"])).toBe(true);
  });

  // A draft is a Ticket a human is still writing. Dispatching one produces a plausible
  // pull request against a half-written spec, which costs more than the delay does.
  it.each(["status:draft", "status:running", "status:review", "status:needs-human"])(
    "does not dispatch %s",
    (label) => {
      expect(isDispatchable([label])).toBe(false);
    },
  );

  it("does not dispatch a Ticket with no status", () => {
    expect(isDispatchable(["lane:claude"])).toBe(false);
  });
});
