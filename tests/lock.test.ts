import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideLock, acquireLock, releaseLock, readLock } from "../src/lock.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "foreman-lock-")), "foreman.lock");
const DEAD = 0x7ffffffe;

describe("decideLock", () => {
  it("takes a free lock", () => {
    expect(decideLock(null, 100)).toBe("take");
  });

  it("blocks when a live process holds it", () => {
    expect(decideLock({ pid: process.pid, at: "" }, process.pid + 1)).toBe("blocked");
  });

  /**
   * The difference from the lock this replaces. The old harness decided staleness from a
   * timestamp with a two-hour window, and could only evaluate it from inside a tick, which
   * was exactly the thing that was stuck. A dead pid is not a heuristic.
   */
  it("takes a lock whose holder is dead, however recently it was taken", () => {
    expect(decideLock({ pid: DEAD, at: new Date().toISOString() }, 100)).toBe("take");
  });

  it("is reentrant for the same process", () => {
    expect(decideLock({ pid: 100, at: "" }, 100)).toBe("take");
  });
});

describe("acquireLock", () => {
  it("acquires, then blocks a different live process", () => {
    const path = tmp();
    expect(acquireLock(path, process.pid).ok).toBe(true);
    const second = acquireLock(path, process.pid + 1);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.heldBy).toBe(process.pid);
  });

  it("reclaims a lock left behind by a killed tick", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ pid: DEAD, at: new Date().toISOString() }));
    expect(acquireLock(path, process.pid).ok).toBe(true);
    expect(readLock(path)?.pid).toBe(process.pid);
  });

  it("treats an unparseable lock as absent rather than jamming for ever", () => {
    const path = tmp();
    writeFileSync(path, "{ not json");
    expect(acquireLock(path, process.pid).ok).toBe(true);
  });
});

describe("releaseLock", () => {
  it("releases its own", () => {
    const path = tmp();
    acquireLock(path, process.pid);
    releaseLock(path, process.pid);
    expect(existsSync(path)).toBe(false);
  });

  // Leaking our own lock is cheap: the next tick reclaims it once we are gone. Deleting
  // someone else's is not.
  it("refuses to release a lock held by another live process", () => {
    const path = tmp();
    acquireLock(path, process.pid);
    releaseLock(path, process.pid + 1);
    expect(existsSync(path)).toBe(true);
  });

  it("is a no-op when there is no lock", () => {
    expect(() => releaseLock(tmp(), process.pid)).not.toThrow();
  });
});
