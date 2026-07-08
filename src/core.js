// Helpers extracted so they're testable without importing index.js (which opens
// an MCP transport on import).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Stable per-watch key. realpath collapses symlinks, `..`, and trailing slashes,
// so the same directory spelled two ways yields ONE slug — one watcher, one results
// file, one lock. The runner is part of the key because a unit runner and playwright
// legitimately coexist in one package as separate watch sessions. Used by both the
// server and the hooks, so they must agree: hence shared here. Falls back to the raw
// path if the dir is missing (can't be watched anyway) to keep the slug
// deterministic. Omitting runner reproduces the legacy runner-less slug (only used
// to match markers left by old versions).
export function slugFor(cwd, runner) {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    /* missing dir */
  }
  if (runner) real += `\0${runner}`;
  return crypto.createHash("sha1").update(real).digest("hex").slice(0, 8);
}

// Is a watch process currently alive for `slug`? True iff its `.live` marker exists in
// `dir` and names a still-running pid. THE single source of truth for "watched" — both
// hooks gate on it so they can't disagree (notify reporting failures for a dir nudge
// calls "not watched"). Reaps the marker if the owning server has died, so a crashed
// session self-heals. Returns the live pid, or 0 if not watched.
export function watcherAlive(dir, slug) {
  const live = path.join(dir, `test-warden-${slug}.live`);
  let pid;
  try {
    // Marker format: "<pid>\n<cwd>" (the cwd lets the session-start reset hook scope
    // eviction to one project); older versions wrote the pid alone.
    pid = Number(fs.readFileSync(live, "utf8").split("\n")[0]);
  } catch {
    return 0; // no marker — not watched
  }
  try {
    process.kill(pid, 0); // probe liveness; throws if the pid is gone
    return pid;
  } catch {
    fs.rmSync(live, { force: true }); // stale marker from a dead/crashed server
    return 0;
  }
}

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
    // `--watch` (not `--watchAll`) reruns only tests related to changed files and
    // runs nothing on a clean tree — it derives "changed" from git/hg, so it needs
    // a VCS repo (jest errors and asks for --watchAll otherwise).
    // `--reporters` is a greedy array flag — keep positional args before it, or jest
    // parses them as extra reporter modules.
    return `"${bin}" --watch${args} --reporters default --reporters "${reporterPath}"`;
  }
  // `--changed` scopes the startup run to files changed vs the working tree (nothing
  // if clean); vitest's watch already reruns only related files after that.
  return `"${bin}" --watch --changed --reporter=default --reporter=json --outputFile="${resultsFile}"${args}`;
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
