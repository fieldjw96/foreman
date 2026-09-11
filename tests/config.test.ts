import { describe, it, expect } from "vitest";
import { expandVars, parseConfig } from "../src/config.ts";

const valid = {
  maxConcurrent: 3,
  runTimeoutMinutes: 45,
  maxAttempts: 2,
  worktreeRoot: "C:/agent-runs",
  secretsDir: "C:/agent-secrets",
  defaultComplexity: "standard",
  models: { high: "opus", standard: "sonnet", low: "haiku" },
  repos: [{ name: "o/r", clonePath: "${OneDrive}/Projects/Repositories/r" }],
};

describe("expandVars", () => {
  // The two laptops do not share a user profile name, so a literal profile path in config
  // is a path that works on exactly one machine.
  it("resolves a variable from the environment", () => {
    expect(expandVars("${OneDrive}/x", { OneDrive: "D:/od" })).toBe("D:/od/x");
  });

  it("throws rather than producing a half-expanded path", () => {
    expect(() => expandVars("${OneDrive}/x", {})).toThrow(/OneDrive/);
  });

  it("leaves a plain path alone", () => {
    expect(expandVars("C:/agent-runs", {})).toBe("C:/agent-runs");
  });
});

describe("parseConfig", () => {
  const env = { OneDrive: "D:/od" };

  it("accepts a valid config and expands clone paths", () => {
    const c = parseConfig(valid, env);
    expect(c.repos[0]!.clonePath).toBe("D:/od/Projects/Repositories/r");
    expect(c.repos[0]!.baseBranch).toBe("main");
  });

  // Every one of these used to be discovered at the moment it was needed, which is the
  // worst possible moment.
  it("rejects a non-integer maxConcurrent", () => {
    expect(() => parseConfig({ ...valid, maxConcurrent: 1.5 }, env)).toThrow(/maxConcurrent/);
  });

  it("rejects a zero timeout", () => {
    expect(() => parseConfig({ ...valid, runTimeoutMinutes: 0 }, env)).toThrow(/runTimeoutMinutes/);
  });

  it("rejects an unknown defaultComplexity", () => {
    expect(() => parseConfig({ ...valid, defaultComplexity: "medium" }, env)).toThrow(/defaultComplexity/);
  });

  it("rejects a missing model tier", () => {
    expect(() => parseConfig({ ...valid, models: { high: "opus", standard: "sonnet" } }, env))
      .toThrow(/models.low/);
  });

  // A repo absent from this array has its Tickets sit for ever and nothing ever says why.
  it("rejects an empty repos array", () => {
    expect(() => parseConfig({ ...valid, repos: [] }, env)).toThrow(/repos/);
  });

  it("rejects a repo name that is not owner/repo", () => {
    expect(() => parseConfig({ ...valid, repos: [{ name: "r", clonePath: "x" }] }, env)).toThrow(/owner\/repo/);
  });

  it("honours an explicit baseBranch", () => {
    const c = parseConfig({ ...valid, repos: [{ name: "o/r", clonePath: "x", baseBranch: "trunk" }] }, env);
    expect(c.repos[0]!.baseBranch).toBe("trunk");
  });
});
