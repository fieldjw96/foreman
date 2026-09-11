import { describe, it, expect } from "vitest";
import { parseEnvFile } from "../src/secrets.ts";

describe("parseEnvFile", () => {
  it("reads plain pairs", () => {
    expect(parseEnvFile("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  // A Postgres URL is full of "=" and "?" and splitting on every "=" silently truncates it
  // into a connection string that fails much later, somewhere unrelated.
  it("keeps everything after the first equals", () => {
    const url = "postgresql://u:p@h:5432/db?sslmode=require&opt=a=b";
    expect(parseEnvFile(`DATABASE_URL=${url}`).DATABASE_URL).toBe(url);
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnvFile("# note\n\nA=1\n\n# another")).toEqual({ A: "1" });
  });

  it("survives CRLF, which is what a file edited on Windows actually contains", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("skips a line with no equals rather than inventing a key", () => {
    expect(parseEnvFile("nonsense\nA=1")).toEqual({ A: "1" });
  });

  it("skips a line beginning with equals", () => {
    expect(parseEnvFile("=oops\nA=1")).toEqual({ A: "1" });
  });
});
