import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Complexity = "low" | "standard" | "high";

export type RepoConfig = {
  name: string;
  clonePath: string;
  baseBranch: string;
};

export type Config = {
  maxConcurrent: number;
  runTimeoutMinutes: number;
  maxAttempts: number;
  maxFixAttempts: number;
  gateReviewer: string;
  worktreeRoot: string;
  secretsDir: string;
  defaultComplexity: Complexity;
  models: Record<Complexity, string>;
  repos: RepoConfig[];
};

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Expands ${OneDrive} and ${VAR} against the environment. The two laptops do not share a
 * user profile name, so a literal C:\Users\<someone> in config is a path that works on
 * exactly one machine and fails silently on the other.
 */
export function expandVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (!resolved) throw new Error(`config refers to \${${name}}, which is not set in the environment`);
    return resolved;
  });
}

const COMPLEXITIES: Complexity[] = ["low", "standard", "high"];

function requirePositiveInt(raw: unknown, key: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`config key "${key}" must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Validates at load rather than at use. A bad number that only surfaces on the tick that
 * needed it is a bug that waits for the worst moment to appear.
 */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  if (typeof raw !== "object" || raw === null) throw new Error("config must be a JSON object");
  const c = raw as Record<string, unknown>;

  const models = c.models as Record<string, unknown> | undefined;
  if (!models) throw new Error('config key "models" is required');
  for (const level of COMPLEXITIES) {
    if (typeof models[level] !== "string") throw new Error(`config key "models.${level}" must be a model id`);
  }

  const defaultComplexity = c.defaultComplexity as Complexity;
  if (!COMPLEXITIES.includes(defaultComplexity)) {
    throw new Error(`config key "defaultComplexity" must be one of ${COMPLEXITIES.join(", ")}`);
  }

  if (!Array.isArray(c.repos) || c.repos.length === 0) {
    throw new Error('config key "repos" must be a non-empty array; a repo missing from it is never looked at');
  }

  const repos: RepoConfig[] = c.repos.map((entry: unknown, i: number) => {
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name.includes("/")) {
      throw new Error(`repos[${i}].name must be "owner/repo"`);
    }
    if (typeof r.clonePath !== "string") throw new Error(`repos[${i}].clonePath must be a string`);
    return {
      name: r.name,
      clonePath: expandVars(r.clonePath, env),
      baseBranch: typeof r.baseBranch === "string" ? r.baseBranch : "main",
    };
  });

  return {
    maxConcurrent: requirePositiveInt(c.maxConcurrent, "maxConcurrent"),
    runTimeoutMinutes: requirePositiveInt(c.runTimeoutMinutes, "runTimeoutMinutes"),
    maxAttempts: requirePositiveInt(c.maxAttempts, "maxAttempts"),
    maxFixAttempts: requirePositiveInt(c.maxFixAttempts ?? 3, "maxFixAttempts"),
    gateReviewer: typeof c.gateReviewer === "string" ? c.gateReviewer : "github-actions",
    worktreeRoot: expandVars(String(c.worktreeRoot ?? "C:\agent-runs"), env),
    secretsDir: expandVars(String(c.secretsDir ?? "C:\agent-secrets"), env),
    defaultComplexity,
    models: models as Record<Complexity, string>,
    repos,
  };
}

export function loadConfig(path = join(repoRoot, "foreman.config.json")): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
