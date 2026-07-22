// Watch-session engine: one warm jest/vitest watch per project dir, piloted over a
// PTY (so run all / filter / failed are just keystrokes written to the pty). Owns the
// sessions map, the pty lifecycle (start/stop/restart), auto-start, the idle sweep,
// and the results/readiness polling the MCP tools block on.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCommand,
  resolveBin,
  normalizeResults,
  slugFor,
  watcherAlive,
} from "./core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JEST_REPORTER = path.join(HERE, "jest-reporter.cjs");

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

// Materialized test setup, loaded and validated once at server startup and injected
// here. It is the ONLY source of truth — no live detection — for how to run each
// dir's tests. Defaults to empty so importing the module (e.g. a test) is inert.
let CONFIG = [];
export const setConfig = (c) => {
  CONFIG = c;
};

// --- watch sessions, keyed by project dir ----------------------------------
export const sessions = new Map(); // cwd -> { proc, runner, cwd, resultsFile, log, triggeredMtime }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve which session a command targets: explicit cwd, else the only one.
export function requireSession(cwd) {
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
export function markTriggered(s) {
  s.triggeredMtime = resultsMtime(s);
  s.lastActivity = Date.now();
}

// Stop a watcher the way a human would — press "q" — so the runner exits gracefully
// and runs its teardown (globalSetup teardown, e.g. stopping the postgres a suite
// spawned). A hard kill skips teardown and leaks those resources: the port stays
// held and the next watch fails to boot. kill() only if the runner ignores "q" for
// the grace period (wedged, or never got ready). Resolves once the process is gone;
// idempotent, so overlapping stop paths (idle sweep + stop_watch) can't double-fire.
// ponytail: env knob instead of config plumbing — TEST_WARDEN_QUIT_GRACE_MS overrides.
export const QUIT_GRACE_MS = Number(process.env.TEST_WARDEN_QUIT_GRACE_MS) || 10_000;
export function stopSession(s) {
  if (!s.stopping) {
    const exited = new Promise((r) => s.proc.onExit(r));
    s.stopping = (async () => {
      try {
        s.proc.write("q");
      } catch {
        /* pty already gone */
      }
      const graceful = await Promise.race([
        exited.then(() => true),
        sleep(QUIT_GRACE_MS).then(() => false),
      ]);
      if (!graceful) s.proc.kill();
      await exited;
    })();
  }
  return s.stopping;
}

// Idle timeout: a warm watcher holds real RAM, and an abandoned session shouldn't
// keep paying it. Activity = an MCP-triggered run or any completed auto-run (the
// results file advancing). Idle watchers are stopped; the next run_* transparently
// restarts them with the same params (cold-start cost, paid once).
// ponytail: env knob instead of config plumbing — TEST_WARDEN_IDLE_MS overrides.
const IDLE_MS = Number(process.env.TEST_WARDEN_IDLE_MS) || 30 * 60_000;
const lastStart = new Map(); // canonical cwd -> { args, env } for restarts
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values())
    if (now - Math.max(s.lastActivity, resultsMtime(s)) > IDLE_MS) stopSession(s);
}, Math.min(IDLE_MS, 60_000)).unref();

// Cross-process guard: is a *different*, still-alive test-warden already watching this
// project? A second file-watch on the same tree is a real perf hit — it can grind the
// machine to a halt — so we refuse rather than spawn a duplicate. Reuses the shared
// liveness check (same marker the hooks read); our own pid (a restart) reads as free.
// This pre-check isn't atomic, and two servers auto-starting on the same cwd at boot
// can collide — so startSession additionally claims the marker with O_EXCL; a lost
// race surfaces as a clean error there, never as a duplicate watcher.
export function watchedElsewhere(cwd) {
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
  // Claim the marker atomically ("wx") BEFORE spawning: two servers auto-starting
  // at the same instant both pass the watchedElsewhere pre-check (it isn't atomic),
  // and a duplicate file-watch on one tree is the perf hit this exists to prevent.
  // The loser gets EEXIST and errors out instead of spawning a second watcher.
  const marker = `${process.pid}\n${cwd}`;
  try {
    fs.writeFileSync(liveFile, marker, { flag: "wx" });
  } catch {
    const pid = watcherAlive(os.tmpdir(), slug); // reaps a stale marker
    if (pid && pid !== process.pid)
      throw new Error(
        `${cwd} is already watched by another test-warden (pid ${pid}).`,
      );
    fs.writeFileSync(liveFile, marker); // stale (reaped) or our own — overwrite
  }
  const cmd = buildCommand(runner, bin, resultsFile, JEST_REPORTER, args);
  const proc = pty.spawn("/bin/sh", ["-c", cmd], {
    name: "xterm-color",
    cols: 120,
    rows: 40,
    cwd,
    // Layer env: base process → caller env (startWatchCore already folded in the
    // config entry's env, or the test script's inline vars as fallback) → our
    // required vars (which must win, esp. CI="" for watch).
    env: {
      ...process.env,
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
export async function startWatchCore(params) {
  let { cwd, args, env } = params;
  // Canonicalize first: the same dir spelled two ways (symlink, trailing slash, `..`)
  // must be one session/one watcher, not two.
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    /* missing dir — the entry lookup below gives the clear error */
  }
  // The test-warden.config.js entry for this dir is the source of truth — there is
  // no detection fallback. Per-call args/env still extend it.
  const cfg = CONFIG.find((e) => e.dir === cwd);
  if (!cfg)
    return {
      error:
        `No test-warden.config.js entry for ${cwd}. Configured dirs: ` +
        `${CONFIG.map((e) => e.dir).join(", ")}. Add an entry (and restart the server) to run tests there.`,
    };
  args = [cfg.args, args].filter(Boolean).join(" ") || undefined;
  env = { ...cfg.env, ...env };
  const bin = cfg.bin ?? resolveBin(cwd, cfg.runner);
  if (!bin)
    return {
      error: `${cfg.runner} is not installed in ${cwd} (no node_modules/.bin/${cfg.runner}). Install deps first, or set \`bin\` in test-warden.config.js.`,
    };
  if (cfg.bin && !fs.existsSync(bin))
    return {
      error: `The bin configured in test-warden.config.js does not exist: ${bin}.`,
    };
  const existing = sessions.get(cwd); // restart only this cwd's watcher
  if (existing) {
    // Await the graceful quit: the old runner's teardown must release its resources
    // (test DB ports, etc.) BEFORE the new runner's setup tries to claim them.
    await stopSession(existing);
  } else {
    // Another live server already watches this dir — typically a forgotten session's.
    // Newest wins: two sessions can't run this project's tests concurrently anyway
    // (suites bind fixed DB ports), and a duplicate file-watch on one tree is a real
    // perf hit — so take the watch over instead of refusing. SIGTERM triggers the
    // owner's shutdown(): it kills its watchers, reaps its markers, and exits.
    // ponytail: SIGTERM kills the owner's watchers on OTHER dirs too — a server is
    // one agent session, so its whole session is stale; per-dir eviction needs an
    // IPC channel this doesn't have.
    const owner = watchedElsewhere(cwd);
    if (owner) {
      try {
        process.kill(owner, "SIGTERM");
      } catch {
        /* already gone */
      }
      // The evicted server quits its watchers gracefully first — allow it that grace.
      const deadline = Date.now() + QUIT_GRACE_MS + 5_000;
      while (watchedElsewhere(cwd) && Date.now() < deadline) await sleep(50);
      if (watchedElsewhere(cwd))
        return {
          error: `${cwd} is watched by another test-warden (pid ${owner}) that did not exit on SIGTERM — kill it manually.`,
        };
    }
  }
  try {
    const session = await startSession({ runner: cfg.runner, bin, cwd, args, env });
    // Store the RAW caller params, not the config-merged ones: an idle-kill restart
    // re-enters this function, which re-applies the config — merged values would
    // apply it twice (cfg.args appended two times).
    lastStart.set(cwd, { args: params.args, env: params.env });
    return { session };
  } catch (e) {
    return { error: e.message }; // e.g. node-pty not compiled — actionable, not a hang
  }
}

// Resolve the run_* target: reuse the live session, or auto-start one so run_* work
// even before start_watch was called. Returns { session } or { error }.
export async function ensureSession(cwd) {
  try {
    return { session: requireSession(cwd) }; // existing: explicit cwd, or the sole session
  } catch (e) {
    // Can only auto-start with a concrete cwd; without one, point at how to proceed.
    if (!cwd)
      return {
        error:
          sessions.size === 0
            ? "No watch running and no cwd given — pass cwd to auto-start a watch here."
            : e.message, // multiple sessions active — requireSession() already says "pass cwd"
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
export async function waitForResults(s) {
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
export async function awaitReady(s) {
  return Promise.race([s.ready, sleep(60_000).then(() => false)]);
}
