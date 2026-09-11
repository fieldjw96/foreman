import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parses a KEY=VALUE file. Values keep everything after the first "=", so a connection
 * string full of "=" survives intact.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Secrets are read from outside OneDrive and passed to the Run as environment variables on
 * its process only. Nothing is ever written into the worktree, so no agent can commit one
 * by accident. A repo with no file here simply gets no secrets.
 */
export function loadRunSecrets(secretsDir: string, repo: string): Record<string, string> {
  const shortName = repo.split("/")[1] ?? repo;
  try {
    return parseEnvFile(readFileSync(join(secretsDir, `${shortName}.env`), "utf8"));
  } catch {
    return {};
  }
}
