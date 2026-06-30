// Helpers extracted so they're testable without importing index.js (which opens
// an MCP transport on import).
import fs from "node:fs";
import path from "node:path";

// Which test runner does the project at `cwd` use? Looks at its package.json deps
// and config files. Returns "jest" | "vitest" | null (neither). Throws if both —
// the caller should then ask for an explicit runner. Detection is per-cwd, so a
// monorepo's packages can each resolve to their own runner.
export function detectRunner(cwd) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch {
    /* no/unreadable package.json — fall through to config-file checks */
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const cfg = (name) =>
    ["js", "ts", "mjs", "cjs", "json"].some((e) =>
      fs.existsSync(path.join(cwd, `${name}.config.${e}`)),
    );
  const vitest = "vitest" in deps || cfg("vitest");
  const jest = "jest" in deps || cfg("jest") || "jest" in pkg; // jest config can be a package.json key
  if (vitest && jest)
    throw new Error(
      `Both jest and vitest detected in ${cwd}; pass runner explicitly.`,
    );
  return vitest ? "vitest" : jest ? "jest" : null;
}

// Absolute path to the runner binary, searching node_modules/.bin from cwd upward
// so hoisted monorepos (bin at the workspace root) resolve too. null if not found.
export function resolveBin(cwd, runner) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin", runner);
    if (fs.existsSync(bin)) return bin;
    if (path.dirname(dir) === dir) return null; // reached filesystem root
  }
}

// Extract leading `KEY=value` assignments from a package.json script command
// (after an optional `cross-env`/`cross-env-shell` prefix). Projects set env this
// way for deterministic tests — e.g. `TZ=UTC jest` to freeze dates — and launching
// the runner binary directly would drop it, causing false negatives. Returns {}.
// ponytail: parses inline + cross-env only; file loaders (dotenv-cli, env-cmd)
// aren't followed — pass those through start_watch's `env` arg.
export function parseScriptEnv(script) {
  if (!script) return {};
  let s = script.trim().replace(/^cross-env(-shell)?\s+/, "");
  const env = {};
  const re = /^(\w+)=("([^"]*)"|'([^']*)'|(\S+))\s+/;
  let m;
  while ((m = re.exec(s))) {
    env[m[1]] = m[3] ?? m[4] ?? m[5];
    s = s.slice(m[0].length);
  }
  return env;
}

// Env vars the project's `test` script sets inline, for the runner at `cwd`.
export function scriptEnv(cwd) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch {
    /* no/unreadable package.json */
  }
  return parseScriptEnv(pkg.scripts?.test);
}

export function buildCommand(runner, bin, resultsFile, reporterPath, extra) {
  const args = extra ? ` ${extra}` : "";
  if (runner === "jest") {
    // `--reporters` is a greedy array flag — keep positional args before it, or jest
    // parses them as extra reporter modules.
    return `"${bin}" --watchAll${args} --reporters default --reporters "${reporterPath}"`;
  }
  return `"${bin}" --watch --reporter=default --reporter=json --outputFile="${resultsFile}"${args}`;
}

// Normalize a parsed results blob into the compact summary the server returns.
// Two near-identical shapes show up: jest's reporter-API AggregatedResult uses
// `testFilePath` + a nested `testResults` array per suite; vitest's json reporter
// (and jest's `--json` CLI) use `name` + `assertionResults`. Accept either.
export function normalizeResults(r) {
  const failures = [];
  for (const suite of r.testResults ?? []) {
    const assertions = suite.assertionResults ?? suite.testResults ?? [];
    const file = suite.name ?? suite.testFilePath;
    for (const a of assertions) {
      if (a.status === "failed") {
        failures.push({
          test: a.fullName || a.title,
          file,
          message: (a.failureMessages ?? []).join("\n").slice(0, 2000),
        });
      }
    }
  }
  return {
    total: r.numTotalTests ?? 0,
    passed: r.numPassedTests ?? 0,
    failed: r.numFailedTests ?? 0,
    suitesFailed: r.numFailedTestSuites ?? 0,
    ok: (r.numFailedTests ?? 0) === 0 && (r.numFailedTestSuites ?? 0) === 0,
    failures,
  };
}
