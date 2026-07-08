#!/usr/bin/env node
// test-warden — pilot jest/vitest watch processes over a PTY from an MCP client.
// One warm watch session per project dir (so a monorepo can watch several at once);
// the pty handles live in memory, so commands (run all / filter / failed) are just
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

// --- watch sessions, keyed by project dir ----------------------------------
const sessions = new Map(); // cwd -> { proc, runner, cwd, resultsFile, log, triggeredMtime }

const CR = "\r";
const text = (s) => ({ content: [{ type: "text", text: s }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve which session a command targets: explicit cwd, else the only one.
function pick(cwd) {
  if (cwd) {
    try {
      cwd = fs.realpathSync(cwd); // match start_watch's canonical key
    } catch {
      /* missing dir — get() misses below and we throw the clear error */
    }
    const s = sessions.get(cwd);
    if (s) return s;
    throw new Error(
      `No watch session for ${cwd}. Active: ${[...sessions.keys()].join(", ") || "none"}.`,
    );
  }
  if (sessions.size === 1) return [...sessions.values()][0];
  if (sessions.size === 0)
    throw new Error("No watch session. Call start_watch first.");
  throw new Error(
    `Multiple watch sessions active — pass cwd. Active: ${[...sessions.keys()].join(", ")}.`,
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
const lastStart = new Map(); // canonical cwd -> { runner, args, env } for restarts
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
function watchedElsewhere(cwd) {
  const pid = watcherAlive(os.tmpdir(), slugFor(cwd));
  return pid === process.pid ? 0 : pid; // our own marker (restart) ⇒ free
}

async function startSession({ runner, bin, cwd, args, env }) {
  const pty = await getPty(); // native addon; throws a clear message if unbuilt
  // Per-cwd results file so concurrent watchers don't clobber each other's JSON.
  const slug = slugFor(cwd);
  const resultsFile = path.join(
    os.tmpdir(),
    `test-warden-${process.pid}-${slug}.json`,
  );
  // Liveness marker for the nudge hook: present + pid-alive ⇒ this cwd is watched.
  // Unlike resultsFile (deleted here, reappears only after the first run), it exists
  // for the whole session, so the hook never false-nudges a freshly-started watch.
  const liveFile = path.join(os.tmpdir(), `test-warden-${slug}.live`);
  try {
    fs.rmSync(resultsFile, { force: true });
  } catch {
    /* ignore */
  }
  const cmd = buildCommand(runner, bin, resultsFile, JEST_REPORTER, args);
  const proc = pty.spawn("/bin/sh", ["-c", cmd], {
    name: "xterm-color",
    cols: 120,
    rows: 40,
    cwd,
    // Layer env: base process → what the project's test script sets (e.g. TZ=UTC)
    // → caller override → our required vars (which must win, esp. CI="" for watch).
    env: {
      ...process.env,
      ...scriptEnv(cwd),
      ...env,
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
  const READY = /Waiting for file changes|Watch Usage/; // vitest | jest idle prompt
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
  fs.writeFileSync(liveFile, String(process.pid));
  lastStart.set(cwd, { runner, args, env }); // so an idle-killed watcher restarts faithfully
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
    if (sessions.get(cwd) === s) {
      sessions.delete(cwd);
      fs.rmSync(liveFile, { force: true });
    }
  });
  // File was just deleted (mtime 0), so the watcher's initial run counts as fresh.
  sessions.set(cwd, s);
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
    try {
      resolved = detectRunner(cwd);
    } catch (e) {
      return { error: e.message }; // both detected — ask the agent to specify
    }
    if (!resolved)
      return {
        error: `No jest or vitest found in ${cwd}. This server only drives those two runners.`,
      };
  }
  const bin = resolveBin(cwd, resolved);
  if (!bin)
    return {
      error: `${resolved} is not installed in ${cwd} (no node_modules/.bin/${resolved}). Install deps first.`,
    };
  const existing = sessions.get(cwd); // restart only this cwd's watcher
  if (existing) {
    existing.proc.kill();
  } else {
    // No local session, but another server process might already watch this dir.
    const owner = watchedElsewhere(cwd);
    if (owner)
      return {
        error:
          `${cwd} is already watched by another test-warden (pid ${owner}). ` +
          `Not starting a second watcher — a duplicate file-watch on the same ` +
          `tree can grind the machine to a halt. Reuse that instance, or stop it first.`,
      };
  }
  try {
    return { session: await startSession({ runner: resolved, bin, cwd, args, env }) };
  } catch (e) {
    return { error: e.message }; // e.g. node-pty not compiled — actionable, not a hang
  }
}

// Resolve the run_* target: reuse the live session, or auto-start one so run_* work
// even before start_watch was called. Returns { session } or { error }.
async function ensureSession(cwd) {
  try {
    return { session: pick(cwd) }; // existing: explicit cwd, or the sole session
  } catch (e) {
    // Can only auto-start with a concrete cwd; without one, point at how to proceed.
    if (!cwd)
      return {
        error:
          sessions.size === 0
            ? "No watch running and no cwd given — pass cwd to auto-start a watch here."
            : e.message, // multiple sessions active — pick() already says "pass cwd"
      };
  }
  // Auto-start — with the same params as the last watch here (e.g. after an idle kill).
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    /* missing dir — startWatchCore reports it */
  }
  return startWatchCore({ cwd, ...lastStart.get(real) });
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
      "Start a jest/vitest watch in the given project. Once started, the watch runs continuously and automatically reruns every test impacted by any unstaged change. After 30 min without a run it stops itself; any run_* call restarts it transparently. The runner is auto-detected from cwd's package.json — only pass it to override.",
    inputSchema: {
      cwd: z
        .string()
        .describe("Absolute path to the project/workspace to run tests in."),
      runner: z
        .enum(["jest", "vitest"])
        .optional()
        .describe("Override auto-detection (e.g. when a package has both)."),
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
// only one is running.
const cwdArg = {
  cwd: z
    .string()
    .optional()
    .describe("Which session (its start_watch cwd). Omit if only one is active."),
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
};

server.registerTool(
  "run_all",
  {
    description:
      "Run the whole suite once and return its pass/fail results (counts + failing tests with messages). Waits for the run to finish. Auto-starts a watch if none is running yet (pass cwd).",
    inputSchema: runCwdArg,
  },
  async ({ cwd }) => {
    const { session: s, error } = await ensureSession(cwd);
    if (error) return text(error);
    if (!(await awaitReady(s))) return notReadyText(s);
    markTriggered(s);
    s.proc.write("a"); // "a" = run all, in the runner's watch UI
    s.fullScope = true; // "a" also durably escapes the startup --changed scope
    return resultsText(await waitForResults(s));
  },
);

server.registerTool(
  "run_failed",
  {
    description:
      "Rerun only the tests that failed in the last run and return the results — faster than the full suite while iterating on a fix. Waits for the run to finish. Auto-starts a watch if none is running (pass cwd).",
    inputSchema: runCwdArg,
  },
  async ({ cwd }) => {
    const { session: s, error } = await ensureSession(cwd);
    if (error) return text(error);
    if (!(await awaitReady(s))) return notReadyText(s);
    markTriggered(s);
    s.proc.write("f"); // "f" = run only failed, in the runner's watch UI
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
  async ({ pattern, by, cwd }) => {
    const { session: s, error } = await ensureSession(cwd);
    if (error) return text(error);
    if (!(await awaitReady(s))) return notReadyText(s);
    // The watch starts scoped to changed files, and the interactive filter only
    // searches within that scope — so a filter for an untouched file finds nothing.
    // Escape once per session: run the full suite ("a") and let it land — filtering
    // mid-run cancels it before the scope widens — then filters see all files.
    // ponytail: costs one full-suite run on a session's first run_filtered; piloting
    // the watcher offers no cheaper reliable escape.
    if (!s.fullScope) {
      markTriggered(s);
      s.proc.write("a");
      await waitForResults(s);
      s.fullScope = true;
    }
    markTriggered(s);
    // Type the filter like a human: one keystroke per write, with a breath between.
    // A coalesced chunk ("todo\r") reaches jest's prompt as ONE key — the pattern
    // shows but the trailing Enter never registers, wedging the watcher in pattern
    // mode and eating every later keystroke.
    s.proc.write(by === "name" ? "t" : "p"); // "t" = filter by test name, "p" = by path
    for (const ch of pattern + CR) {
      await sleep(25);
      s.proc.write(ch);
    }
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
  async ({ cwd }) => {
    const s = pick(cwd);
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
  async ({ cwd }) =>
    text(pick(cwd).log.join("").slice(-4000) || "(no output yet)"),
);

server.registerTool(
  "stop_watch",
  {
    description: "Stop the continuous watch for a project, or all watches when cwd is omitted.",
    inputSchema: cwdArg,
  },
  async ({ cwd }) => {
    // pick() realpaths cwd so a symlink/trailing-slash spelling still finds the session.
    const targets = cwd ? [pick(cwd)] : [...sessions.values()];
    if (!targets.length) return text("No session running.");
    for (const s of targets) {
      s.proc.kill();
      sessions.delete(s.cwd);
      // onExit's cleanup is guarded by `sessions.get(cwd) === s`, which the delete
      // above just broke — reap the live marker here or it outlives the session.
      fs.rmSync(s.liveFile, { force: true });
    }
    return text(`Stopped: ${targets.map((s) => s.cwd).join(", ")}.`);
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
