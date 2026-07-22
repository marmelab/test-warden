// Pure helpers, kept out of the server entrypoint so tests can import them without
// index.js — importing that opens an MCP transport.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stable per-project key. realpath collapses symlinks, `..`, and trailing slashes,
// so the same directory spelled two ways yields ONE slug — one watcher, one results
// file, one lock. Used by both the server and the nudge hook, so they must agree:
// hence shared here. Falls back to the raw path if the dir is missing (can't be
// watched anyway) to keep the slug deterministic.
export function slugFor(cwd) {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    /* missing dir */
  }
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
    // Marker format: "<pid>\n<cwd>" — the cwd lets the session-start reset hook scope
    // eviction to one project; the pid is the first line.
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

// Schema check, hand-rolled (no zod). This file is copied next to the project's hooks
// by `init`, decoupled from any node_modules — so a dependency here would resolve only
// if the USER's project happened to ship it, silently skipping validation otherwise
// (the nudge hook's whole job is to surface a broken config). Plain JS ships intact.
// The server still uses zod for its MCP tool schemas (tools.js); only this validator
// must stay dependency-free. Errors read `entries[i].key: why`, mirroring the old zod
// output the callers and tests expect.
const ALLOWED = ["dir", "runner", "args", "env", "bin"];
function validateConfig(entries, file) {
  const issues = [];
  if (!Array.isArray(entries)) issues.push("entries: expected an array");
  else if (entries.length === 0) issues.push("entries: at least one entry is required");
  const out = [];
  for (const [i, e] of (Array.isArray(entries) ? entries : []).entries()) {
    const at = `entries[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      issues.push(`${at}: expected an object`);
      continue;
    }
    for (const k of Object.keys(e))
      if (!ALLOWED.includes(k)) issues.push(`${at}.${k}: unrecognized key (likely a typo)`);
    if (e.runner !== "jest" && e.runner !== "vitest")
      issues.push(`${at}.runner: must be "jest" or "vitest"`);
    for (const k of ["dir", "args", "bin"])
      if (e[k] !== undefined && typeof e[k] !== "string")
        issues.push(`${at}.${k}: expected a string`);
    if (e.env !== undefined) {
      if (e.env === null || typeof e.env !== "object" || Array.isArray(e.env))
        issues.push(`${at}.env: expected an object of string values`);
      else
        for (const [k, v] of Object.entries(e.env))
          if (typeof v !== "string") issues.push(`${at}.env.${k}: expected a string`);
    }
    out.push({
      dir: e.dir ?? ".",
      runner: e.runner,
      args: e.args ?? "",
      env: e.env ?? {},
      ...(e.bin !== undefined && { bin: e.bin }),
    });
  }
  if (issues.length)
    throw new Error(
      `Invalid ${file} — ${issues.join("; ")}. Fix it by hand or regenerate with \`npx test-warden bootstrap\` (overwrites).`,
    );
  return out;
}

// Load and validate test-warden.config.js from `root` — the REQUIRED description of
// how to run this project's tests (bootstrapped by `test-warden init`, then
// hand-maintained). Throws an actionable error if the file is missing, doesn't parse,
// or fails the schema. Each entry describes one package with tests:
// { dir, runner, args, env, bin? }. `dir` and `bin` are relative to the config file;
// they come back absolute (dir realpath'd, to match the server's canonical session
// keys). import() handles both module.exports and export default.
export async function loadConfig(root) {
  const file = path.join(root, "test-warden.config.js");
  if (!fs.existsSync(file))
    throw new Error(
      `${file} not found. Run \`npx test-warden init\` to bootstrap it, then edit it to describe your test setup.`,
    );
  const mod = await import(pathToFileURL(file).href);
  const entries = validateConfig([].concat(mod.default ?? []), file);
  return entries.map((e) => {
    let dir = path.resolve(root, e.dir);
    try {
      dir = fs.realpathSync(dir);
    } catch {
      /* missing dir — the server reports it when targeted */
    }
    return { ...e, dir, ...(e.bin && { bin: path.resolve(root, e.bin) }) };
  });
}

export function buildCommand(runner, bin, resultsFile, reporterPath, extra) {
  // `extra` (config `args` + any per-call args) is spliced into the `sh -c` string
  // UNQUOTED — it's a run of flags, not one shell token, so it can't be quoted like
  // bin/resultsFile are. It therefore reaches the shell verbatim: benign here (config
  // and MCP caller are trusted, and running the project's own tests is arbitrary code
  // execution by design), but any untrusted value routed through it is an injection path.
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
