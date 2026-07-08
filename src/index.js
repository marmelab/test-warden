#!/usr/bin/env node
// test-warden — pilot jest/vitest/playwright watch processes over a PTY from an MCP
// client. One warm watch session per (project dir, runner) pair — a monorepo can
// watch several packages, and one package can watch unit + e2e side by side; the
// pty handles live in memory, so commands (run all / filter / failed) are just
// keystrokes written to the pty.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  buildCommand,
  detectPlaywright,
  detectRunner,
  resolveBin,
  scriptEnv,
  normalizeResults,
  slugFor,
  watcherAlive,
} from "./core.js";

// `test-warden init` wires the server + hook into the current project, then exits.
if (process.argv[2] === "init") {
  const { run } = await import("./init.js");
  run();
  process.exit(0);
}

// node-pty is a native addon with NO Linux prebuilt binary — it must be compiled
// (pnpm approve-builds / npm rebuild). Import it lazily, on first start_watch, not at
// module load: an unbuilt addon then surfaces as a clear error from the tool call
// instead of killing the server before the MCP handshake (which a client shows as a
// permanent "Connecting…"). `init` never reaches this, so it stays addon-free.
let ptyMod;
async function getPty() {
  try {
    return (ptyMod ??= (await import("node-pty")).default);
  } catch (e) {
    throw new Error(
      "node-pty failed to load — it has no Linux prebuild and must be compiled. Run " +
        "`pnpm approve-builds` (or `npm rebuild node-pty`) where test-warden is " +
        `installed, then restart. Original error: ${e.message}`,
    );
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JEST_REPORTER = path.join(HERE, "jest-reporter.cjs");

// --- watch sessions, keyed by (project dir, runner) -------------------------
// One package legitimately holds two sessions: its unit runner and playwright.
const sessions = new Map(); // keyFor(cwd, runner) -> { proc, runner, cwd, resultsFile, log, triggeredMtime }
const keyFor = (cwd, runner) => `${cwd}\0${runner}`;

const CR = "\r";
const text = (s) => ({ content: [{ type: "text", text: s }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describe = (s) => `${s.cwd} [${s.runner}]`;

// Resolve which session a command targets: explicit cwd/runner, else the only match.
function pick(cwd, runner) {
  if (cwd) {
    try {
      cwd = fs.realpathSync(cwd); // match start_watch's canonical key
    } catch {
      /* missing dir — the filter misses below and we throw the clear error */
    }
  }
  const matches = [...sessions.values()].filter(
    (s) => (!cwd || s.cwd === cwd) && (!runner || s.runner === runner),
  );
  if (matches.length === 1) return matches[0];
  const active = [...sessions.values()].map(describe).join(", ");
  if (sessions.size === 0)
    throw new Error("No watch session. Call start_watch first.");
  if (matches.length === 0)
    throw new Error(`No matching watch session. Active: ${active}.`);
  throw new Error(
    `Several watch sessions match — pass ${cwd ? "runner" : "cwd (and runner if the dir has both)"}. Active: ${active}.`,
  );
}

// mtime of the results file, or 0 if it doesn't exist yet. Both jest's reporter
// and vitest's --outputFile rewrite the file on each run, so a rising mtime is
// the "a new run finished" edge.
// ponytail: relies on sub-second mtime (ext4/xfs/apfs have it); on a 1s-granularity
// FS a rerun finishing within the same second as the trigger reads as stale. Move
// to a run counter written by the reporter if that ever bites.
function resultsMtime(s) {
  try {
    return fs.statSync(s.resultsFile).mtimeMs;
  } catch {
    return 0;
  }
}

// Record the file's mtime at the instant a run is triggered, so get_results can
// tell the freshly-finished run apart from the previous run's leftover JSON.
function markTriggered(s) {
  s.triggeredMtime = resultsMtime(s);
  s.lastActivity = Date.now();
}

// Idle timeout: a warm watcher holds real RAM, and an abandoned session shouldn't
// keep paying it. Activity = an MCP-triggered run or any completed auto-run (the
// results file advancing). Idle watchers are killed; the next run_* transparently
// restarts them with the same params (cold-start cost, paid once).
// ponytail: env knob instead of config plumbing — TEST_WARDEN_IDLE_MS overrides.
const IDLE_MS = Number(process.env.TEST_WARDEN_IDLE_MS) || 30 * 60_000;
const lastStart = new Map(); // keyFor(cwd, runner) -> { runner, args, env } for restarts
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values())
    if (now - Math.max(s.lastActivity, resultsMtime(s)) > IDLE_MS) s.proc.kill();
}, Math.min(IDLE_MS, 60_000)).unref();

// Cross-process guard: is a *different*, still-alive test-warden already watching this
// project? A second file-watch on the same tree is a real perf hit — it can grind the
// machine to a halt — so we refuse rather than spawn a duplicate. Reuses the shared
// liveness check (same marker the hooks read); our own pid (a restart) reads as free.
// ponytail: check-then-spawn isn't atomic — two servers starting in the same
// millisecond could both win. Realistic triggers (config, two editor windows) are
// human-paced, so a plain check suffices; switch to an O_EXCL lockfile only if
// simultaneous starts ever actually collide.
function watchedElsewhere(cwd, runner) {
  // Probe the legacy runner-less slug too: a pre-runner-keyed server's marker must
  // still block/evict, and watcherAlive reaps it once that server is dead.
  const pid =
    watcherAlive(os.tmpdir(), slugFor(cwd, runner)) ||
    watcherAlive(os.tmpdir(), slugFor(cwd));
  return pid === process.pid ? 0 : pid; // our own marker (restart) ⇒ free
}

async function startSession({ runner, bin, cwd, args, env }) {
  const pty = await getPty(); // native addon; throws a clear message if unbuilt
  // Per-(cwd, runner) results file so concurrent watchers don't clobber each other.
  const slug = slugFor(cwd, runner);
  const resultsFile = path.join(
    os.tmpdir(),
    `test-warden-${process.pid}-${slug}.json`,
  );
  // Liveness marker for the nudge hook: present + pid-alive ⇒ this pair is watched.
  // Unlike resultsFile (deleted here, reappears only after the first run), it exists
  // for the whole session, so the hook never false-nudges a freshly-started watch.
  const liveFile = path.join(os.tmpdir(), `test-warden-${slug}.live`);
  try {
    fs.rmSync(resultsFile, { force: true });
  } catch {
    /* ignore */
  }
  const cmd = buildCommand(runner, bin, resultsFile, JEST_REPORTER, args);
  // Playwright's watch is env-gated, and its watch loop drops CLI --reporter — but
  // appends the PW_TEST_REPORTER reporter to every run, which reads its output path
  // from PLAYWRIGHT_JSON_OUTPUT_NAME (see buildCommand).
  const pwEnv =
    runner === "playwright"
      ? {
          PWTEST_WATCH: "1",
          PW_TEST_REPORTER: "json",
          PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile,
        }
      : {};
  const proc = pty.spawn("/bin/sh", ["-c", cmd], {
    name: "xterm-color",
    cols: 120,
    rows: 40,
    cwd,
    // Layer env: base process → what the project's test script sets (e.g. TZ=UTC)
    // → caller override → our required vars (which must win, esp. CI="" for watch).
    env: {
      ...process.env,
      ...scriptEnv(cwd, runner),
      ...env,
      ...pwEnv,
      TEST_WATCH_MCP_OUT: resultsFile,
      CI: "",
    },
  });
  const log = [];
  // Keystrokes written before the runner's watch UI is up are silently lost, so
  // run_* must wait for readiness. The runner's own output is the signal: each
  // prints its idle-prompt marker once (and only once) it accepts keys.
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  const READY = /Waiting for file changes|Watch Usage/; // vitest+playwright | jest idle prompt
  let tail = "";
  proc.onData((d) => {
    log.push(d);
    if (log.length > 400) log.splice(0, log.length - 400);
    if (readyResolve) {
      tail = (tail + d).slice(-1000); // rolling window; marker may span chunks
      if (READY.test(tail)) {
        readyResolve(true);
        readyResolve = null;
      }
    }
  });
  fs.writeFileSync(liveFile, `${process.pid}\n${cwd}`); // see watcherAlive for the format
  lastStart.set(keyFor(cwd, runner), { runner, args, env }); // so an idle-killed watcher restarts faithfully
  const s = {
    proc,
    runner,
    cwd,
    resultsFile,
    liveFile,
    log,
    ready,
    triggeredMtime: 0,
    lastActivity: Date.now(),
  };
  proc.onExit(() => {
    // Guarded: a restart (kill old → start new) writes the new marker before the
    // old proc's exit fires, so only the still-current session clears it.
    if (sessions.get(keyFor(cwd, runner)) === s) {
      sessions.delete(keyFor(cwd, runner));
      fs.rmSync(liveFile, { force: true });
    }
  });
  // File was just deleted (mtime 0), so the watcher's initial run counts as fresh.
  sessions.set(keyFor(cwd, runner), s);
  return s;
}

// Read whichever reporter wrote results and normalize to a compact summary.
function readResults(s) {
  let raw;
  try {
    raw = fs.readFileSync(s.resultsFile, "utf8");
  } catch {
    return null; // no run has completed yet
  }
  try {
    return normalizeResults(JSON.parse(raw));
  } catch {
    return null; // mid-write
  }
}

// Start (or restart) a watch for cwd. Returns { session } on success, or { error } —
// a ready-to-show message — on any failure: bad dir, no/ambiguous runner, not
// installed, already watched by another process, or native addon missing. Shared by
// start_watch and the run_* tools' auto-start.
async function startWatchCore({ runner, cwd, args, env }) {
  // Canonicalize first: the same dir spelled two ways (symlink, trailing slash, `..`)
  // must be one session/one watcher, not two.
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    /* missing dir — detectRunner/resolveBin below give the clear error */
  }
  let resolved = runner;
  if (!resolved) {
    let unit;
    try {
      unit = detectRunner(cwd);
    } catch (e) {
      return { error: e.message }; // jest AND vitest — ask the agent to specify
    }
    // Playwright coexisting with a unit runner is the normal setup, but an
    // auto-detected start can't guess which of the two the agent means.
    if (unit && detectPlaywright(cwd))
      return {
        error: `${cwd} has both ${unit} and playwright — pass runner to say which to watch.`,
      };
    resolved = unit ?? (detectPlaywright(cwd) ? "playwright" : null);
    if (!resolved)
      return {
        error: `No jest, vitest or playwright found in ${cwd}. This server only drives those runners.`,
      };
  }
  const bin = resolveBin(cwd, resolved);
  if (!bin)
    return {
      error: `${resolved} is not installed in ${cwd} (no node_modules/.bin/${resolved}). Install deps first.`,
    };
  const existing = sessions.get(keyFor(cwd, resolved)); // restart only this pair's watcher
  if (existing) {
    existing.proc.kill();
  } else {
    // Another live server already watches this dir — typically a forgotten session's.
    // Newest wins: two sessions can't run this project's tests concurrently anyway
    // (suites bind fixed DB ports), and a duplicate file-watch on one tree is a real
    // perf hit — so take the watch over instead of refusing. SIGTERM triggers the
    // owner's shutdown(): it kills its watchers, reaps its markers, and exits.
    // ponytail: SIGTERM kills the owner's watchers on OTHER dirs too — a server is
    // one agent session, so its whole session is stale; per-dir eviction needs an
    // IPC channel this doesn't have.
    const owner = watchedElsewhere(cwd, resolved);
    if (owner) {
      try {
        process.kill(owner, "SIGTERM");
      } catch {
        /* already gone */
      }
      const deadline = Date.now() + 5_000;
      while (watchedElsewhere(cwd, resolved) && Date.now() < deadline)
        await sleep(50);
      if (watchedElsewhere(cwd, resolved))
        return {
          error: `${cwd} is watched by another test-warden (pid ${owner}) that did not exit on SIGTERM — kill it manually.`,
        };
    }
  }
  try {
    return { session: await startSession({ runner: resolved, bin, cwd, args, env }) };
  } catch (e) {
    return { error: e.message }; // e.g. node-pty not compiled — actionable, not a hang
  }
}

// Resolve the run_* target: reuse the live session, or auto-start one so run_* work
// even before start_watch was called. Returns { session } or { error }.
async function ensureSession(cwd, runner) {
  try {
    return { session: pick(cwd, runner) }; // existing: explicit args, or the sole match
  } catch (e) {
    // Can only auto-start with a concrete cwd; without one, point at how to proceed.
    if (!cwd)
      return {
        error:
          sessions.size === 0
            ? "No watch running and no cwd given — pass cwd to auto-start a watch here."
            : e.message, // several sessions match — pick() already says what to pass
      };
  }
  // Auto-start — with the same params as the last watch here (e.g. after an idle
  // kill). Without an explicit runner, a single remembered start for this cwd is
  // unambiguous; several (unit + e2e watched earlier) fall through to detection,
  // which errors with "pass runner".
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    /* missing dir — startWatchCore reports it */
  }
  const remembered = runner
    ? [lastStart.get(keyFor(real, runner))]
    : [...lastStart.entries()]
        .filter(([k]) => k.startsWith(`${real}\0`))
        .map(([, v]) => v);
  const params = remembered.length === 1 ? remembered[0] : undefined;
  return startWatchCore({ cwd, runner, ...params });
}

// Block until the watch's in-flight run lands, rather than returning pending and making
// the agent poll. Trust the JSON only once its mtime advanced past the trigger (a fresh
// run) and it parses (not mid-write). Returns the summary, or null if still running.
// ponytail: 30s ceiling so we return before a typical MCP client request timeout; bump
// it or make it an arg if a suite legitimately runs longer.
async function waitForResults(s) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = resultsMtime(s) > s.triggeredMtime ? readResults(s) : null;
    if (res) return res;
    await sleep(100);
  }
  return null;
}

// Wait until the watcher accepts keystrokes (its idle prompt appeared). True when
// ready; false if it never got there — the caller should point at tail_log.
// ponytail: 60s boot ceiling; a big suite's cold start can exceed it — bump if seen.
async function awaitReady(s) {
  return Promise.race([s.ready, sleep(60_000).then(() => false)]);
}

const notReadyText = (s) =>
  text(
    `The ${s.runner} watcher in ${s.cwd} is still starting up — not accepting commands yet. Check tail_log for what it's doing.`,
  );

const resultsText = (res) =>
  text(
    res
      ? JSON.stringify(res, null, 2)
      : JSON.stringify({ pending: true }, null, 2) +
          "\n// Still running after 30s — retry, or check tail_log.",
  );

// --- MCP server -------------------------------------------------------------
const server = new McpServer({ name: "test-warden", version: "0.1.0" });

server.registerTool(
  "start_watch",
  {
    description:
      "Start a jest/vitest/playwright watch in the given project. Once started, the watch runs continuously and automatically reruns every test impacted by any unstaged change (playwright: any change to a test file or a file it imports; headless). One watch per (cwd, runner) pair — a package can watch its unit runner and playwright side by side. After 30 min without a run it stops itself; any run_* call restarts it transparently. The runner is auto-detected from cwd's package.json — pass it when a package has several (e.g. vitest + playwright).",
    inputSchema: {
      cwd: z
        .string()
        .describe("Absolute path to the project/workspace to run tests in."),
      runner: z
        .enum(["jest", "vitest", "playwright"])
        .optional()
        .describe("Override auto-detection — required when a package has both a unit runner and playwright."),
      args: z
        .string()
        .optional()
        .describe(
          "Extra CLI args appended to the runner (e.g. a path filter).",
        ),
      env: z
        .record(z.string())
        .optional()
        .describe(
          "Extra env vars for the runner. Inline assignments in the project's `test` script (e.g. TZ=UTC) are applied automatically; use this for file-loaded vars (dotenv) or overrides.",
        ),
    },
  },
  async ({ runner, cwd, args, env }) => {
    const { session, error } = await startWatchCore({ runner, cwd, args, env });
    if (error) return text(error);
    if (!(await awaitReady(session))) return notReadyText(session);
    return text(
      `Started ${session.runner} watch in ${session.cwd}. ${sessions.size} session(s) active. ` +
        `Editing code auto-reruns impacted tests; call get_results to read them, or ` +
        `run_all / run_failed / run_filtered to force a specific run.`,
    );
  },
);

// Shared selector: which watch session a command targets. Optional — omit when
// only one matches.
const runnerArg = {
  runner: z
    .enum(["jest", "vitest", "playwright"])
    .optional()
    .describe(
      "Which runner's session, when one dir watches several (e.g. vitest + playwright). Omit otherwise.",
    ),
};
const cwdArg = {
  cwd: z
    .string()
    .optional()
    .describe("Which session (its start_watch cwd). Omit if only one is active."),
  ...runnerArg,
};

// run_* also auto-start a watch when none is running, so for them cwd doubles as the
// directory to start in.
const runCwdArg = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Project dir. Omit if a single watch is already running; pass it to target a specific watch, or to auto-start one if none is running.",
    ),
  ...runnerArg,
};

server.registerTool(
  "run_all",
  {
    description:
      "Run the whole suite once and return its pass/fail results (counts + failing tests with messages). Waits for the run to finish. Auto-starts a watch if none is running yet (pass cwd).",
    inputSchema: runCwdArg,
  },
  async ({ cwd, runner }) => {
    const { session: s, error } = await ensureSession(cwd, runner);
    if (error) return text(error);
    if (!(await awaitReady(s))) return notReadyText(s);
    if (s.runner === "playwright") return resultsText(await playwrightRunAll(s));
    markTriggered(s);
    s.proc.write("a"); // "a" = run all, in the runner's watch UI
    s.fullScope = true; // "a" also durably escapes the startup --changed scope
    return resultsText(await waitForResults(s));
  },
);

// Playwright's watch has no "run all" key: Enter reruns with the CURRENT filters,
// and filters persist across runs. Submitting an EMPTY filter prompt clears that
// filter and immediately runs — so clear whatever this session set (name first:
// the last clearing run, with every filter gone, IS the full run) and only fall
// back to a plain Enter when nothing was filtered.
async function playwrightRunAll(s) {
  let res = null;
  for (const [flag, key] of [
    ["nameFiltered", "t"],
    ["pathFiltered", "p"],
  ]) {
    if (!s[flag]) continue;
    markTriggered(s);
    await typeInto(s, key, "");
    res = await waitForResults(s);
    s[flag] = false;
  }
  if (!res) {
    markTriggered(s);
    s.proc.write(CR); // Enter = run tests (no filters set → all of them)
    res = await waitForResults(s);
  }
  return res;
}

// Open a watch filter prompt (`p` = file, `t` = test name) and type `pattern` into
// it like a human: one keystroke per write, with a breath between. A coalesced
// chunk ("todo\r") reaches the prompt as ONE key — the pattern shows but the
// trailing Enter never registers, wedging the watcher in pattern mode and eating
// every later keystroke. The first pause is longer for playwright, whose prompt
// (enquirer) mounts asynchronously and drops keys typed before it's up.
async function typeInto(s, key, pattern) {
  s.proc.write(key);
  if (s.runner === "playwright") await sleep(300);
  for (const ch of pattern + CR) {
    await sleep(25);
    s.proc.write(ch);
  }
}

server.registerTool(
  "run_failed",
  {
    description:
      "Rerun only the tests that failed in the last run and return the results — faster than the full suite while iterating on a fix. Waits for the run to finish. Auto-starts a watch if none is running (pass cwd).",
    inputSchema: runCwdArg,
  },
  async ({ cwd, runner }) => {
    const { session: s, error } = await ensureSession(cwd, runner);
    if (error) return text(error);
    if (!(await awaitReady(s))) return notReadyText(s);
    markTriggered(s);
    s.proc.write("f"); // "f" = run only failed, in every runner's watch UI
    return resultsText(await waitForResults(s));
  },
);

server.registerTool(
  "run_filtered",
  {
    description:
      "Run only the tests matching a pattern (by file path or test name) and return the results — use to focus on one area. Waits for the run to finish. Auto-starts a watch if none is running (pass cwd).",
    inputSchema: {
      pattern: z.string().describe("Regex/substring to filter by."),
      by: z
        .enum(["path", "name"])
        .default("path")
        .describe("Match the pattern against the test file path (default) or the test name."),
      ...runCwdArg,
    },
  },
  async ({ pattern, by, cwd, runner }) => {
    const { session: s, error } = await ensureSession(cwd, runner);
    if (error) return text(error);
    if (!(await awaitReady(s))) return notReadyText(s);
    // jest/vitest watches start scoped to changed files, and the interactive filter
    // only searches within that scope — so a filter for an untouched file finds
    // nothing. Escape once per session: run the full suite ("a") and let it land —
    // filtering mid-run cancels it before the scope widens — then filters see all
    // files. Playwright has no startup scope (its watch idles until a run).
    // ponytail: costs one full-suite run on a session's first run_filtered; piloting
    // the watcher offers no cheaper reliable escape.
    if (!s.fullScope && s.runner !== "playwright") {
      markTriggered(s);
      s.proc.write("a");
      await waitForResults(s);
      s.fullScope = true;
    }
    markTriggered(s);
    // "t" = filter by test name, "p" = by path — same keys in all three watch UIs.
    // Playwright filters persist across runs; remember what we set so run_all can
    // clear it.
    s[by === "name" ? "nameFiltered" : "pathFiltered"] = true;
    await typeInto(s, by === "name" ? "t" : "p", pattern);
    return resultsText(await waitForResults(s));
  },
);

server.registerTool(
  "get_results",
  {
    description:
      "Read the latest run's results (pass/fail counts and failing tests with messages) without triggering a new run — use after editing code, since the watch auto-reruns impacted tests. Waits for an in-progress run to finish. Requires start_watch first (or use a run_* tool, which auto-starts).",
    inputSchema: cwdArg,
  },
  async ({ cwd, runner }) => {
    const s = pick(cwd, runner);
    return resultsText(await waitForResults(s));
  },
);

server.registerTool(
  "tail_log",
  {
    description:
      "Raw recent watcher output — for debugging the session, e.g. when get_results stays pending or the watcher seems stuck.",
    inputSchema: cwdArg,
  },
  async ({ cwd, runner }) =>
    text(pick(cwd, runner).log.join("").slice(-4000) || "(no output yet)"),
);

server.registerTool(
  "stop_watch",
  {
    description:
      "Stop the continuous watch for a project — all of the dir's watches when runner is omitted (cwd means \"everything here\"), all watches everywhere when cwd is omitted too.",
    inputSchema: cwdArg,
  },
  async ({ cwd, runner }) => {
    if (cwd) {
      try {
        cwd = fs.realpathSync(cwd); // match start_watch's canonical key
      } catch {
        /* missing dir — the filter below just finds nothing */
      }
    }
    const targets = [...sessions.values()].filter(
      (s) => (!cwd || s.cwd === cwd) && (!runner || s.runner === runner),
    );
    if (!targets.length) return text("No matching session running.");
    for (const s of targets) {
      s.proc.kill();
      sessions.delete(keyFor(s.cwd, s.runner));
      // onExit's cleanup is guarded by `sessions.get(key) === s`, which the delete
      // above just broke — reap the live marker here or it outlives the session.
      fs.rmSync(s.liveFile, { force: true });
    }
    return text(`Stopped: ${targets.map(describe).join(", ")}.`);
  },
);

// Die with the client. The pty children keep the event loop alive, so without this a
// finished session leaves a zombie server whose watchers keep rerunning tests on every
// edit (colliding with the next session's runs — e.g. on a shared test database) and
// whose .live markers lock the projects against the next session's server.
function shutdown() {
  for (const s of sessions.values()) {
    s.proc.kill();
    fs.rmSync(s.liveFile, { force: true });
  }
  process.exit(0);
}
process.stdin.on("end", shutdown); // client closed the pipe — the session is over
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
