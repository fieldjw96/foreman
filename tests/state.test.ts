import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, isProcessAlive, ageMinutes } from "../src/state.ts";
import { branchName, worktreePath } from "../src/git.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "foreman-"));

describe("state file", () => {
  it("round-trips", () => {
    const path = join(tmp(), "state.json");
    const runs = [{
      repo: "o/r", issue: 7, pid: 1, branch: "ticket/7",
      worktree: "w", logFile: "l", startedAt: "2026-09-10T12:00:00.000Z",
    }];
    writeState(path, { runs });
    expect(readState(path).runs).toEqual(runs);
  });

  it("creates the directory it is asked to write into", () => {
    const path = join(tmp(), "nested", "deep", "state.json");
    writeState(path, { runs: [] });
    expect(readState(path)).toEqual({ runs: [] });
  });

  // Losing this file must cost a reconciliation pass and never a Ticket, because the
  // Ticket's own label is the real record.
  it("reads a missing file as empty rather than throwing", () => {
    expect(readState(join(tmp(), "absent.json"))).toEqual({ runs: [] });
  });

  it("reads a corrupt file as empty rather than throwing", () => {
    const path = join(tmp(), "bad.json");
    writeFileSync(path, "{ not json");
    expect(readState(path)).toEqual({ runs: [] });
  });

  it("reads valid JSON of the wrong shape as empty", () => {
    const path = join(tmp(), "wrong.json");
    writeFileSync(path, '{"runs":"nope"}');
    expect(readState(path)).toEqual({ runs: [] });
  });

  it("leaves no temp file behind", () => {
    const path = join(tmp(), "state.json");
    writeState(path, { runs: [] });
    expect(() => readFileSync(`${path}.tmp`, "utf8")).toThrow();
  });
});

describe("isProcessAlive", () => {
  it("sees this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("does not see a pid that cannot exist", () => {
    expect(isProcessAlive(0x7ffffffe)).toBe(false);
  });
});

describe("ageMinutes", () => {
  it("measures from the start time", () => {
    expect(ageMinutes("2026-09-10T12:00:00.000Z", new Date("2026-09-10T12:30:00Z"))).toBe(30);
  });
});

describe("worktree naming", () => {
  it("names the branch after the Ticket", () => {
    expect(branchName(47)).toBe("ticket/47");
  });

  // Two repos with the same issue number must not land on the same directory.
  it("separates repos by name", () => {
    const a = worktreePath("C:/agent-runs", "o/rolodeck-ai", 12);
    const b = worktreePath("C:/agent-runs", "o/other", 12);
    expect(a).not.toBe(b);
    expect(a).toContain("rolodeck-ai");
  });

  it("puts Runs outside OneDrive", () => {
    expect(worktreePath("C:/agent-runs", "o/r", 1).toLowerCase()).not.toContain("onedrive");
  });
});
