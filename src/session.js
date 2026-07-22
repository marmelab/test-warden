// Watch-session registry + orchestration: owns the sessions map keyed by project dir,
// resolves which session a command targets, and starts/restarts/auto-starts watches
// (delegating the actual pty spawn to watcher.js), plus the idle sweep that reclaims
// abandoned ones. The MCP tools call into here.
import fs from "node:fs";
import { resolveBin, sleep } from "./core.js";
import { resultsMtime } from "./results.js";
import {
  spawnWatcher,
  stopSession,
  watchedElsewhere,
  QUIT_GRACE_MS,
} from "./watcher.js";

// Re-export the single-watcher lifecycle helpers so callers (tools.js, index.js) get
// the whole engine surface from one module; watcher.js stays an internal detail.
export { stopSession, watchedElsewhere, QUIT_GRACE_MS };

// Materialized test setup, loaded and validated once at server startup and injected
// here. It is the ONLY source of truth — no live detection — for how to run each
// dir's tests. Defaults to empty so importing the module (e.g. a test) is inert.
let CONFIG = [];
export const setConfig = (c) => {
  CONFIG = c;
};

// Keyed by canonical project dir so the same dir spelled two ways can't open two
// watchers; the session object's shape is defined where it's built (watcher.js).
export const sessions = new Map();

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

// Idle timeout: a warm watcher holds real RAM, and an abandoned session shouldn't
// keep paying it. Activity = an MCP-triggered run or any completed auto-run (the
// results file advancing). Idle watchers are stopped; the next run_* transparently
// restarts them with the same params (cold-start cost, paid once).
// ponytail: env knob instead of config plumbing — TEST_WARDEN_IDLE_MS overrides.
const IDLE_MS = Number(process.env.TEST_WARDEN_IDLE_MS) || 30 * 60_000;
const lastStart = new Map(); // canonical cwd -> { args, env } for restarts

// Start the idle sweep. Called once at server startup, never at import — importing
// this module must stay side-effect-free (tests import it). Unref'd so the timer
// alone can't keep the process alive.
export function startIdleSweep() {
  setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values())
      if (now - Math.max(s.lastActivity, resultsMtime(s)) > IDLE_MS) stopSession(s);
  }, Math.min(IDLE_MS, 60_000)).unref();
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
    const session = await spawnWatcher({ runner: cfg.runner, bin, cwd, args, env });
    // Register into the map and wire the exit cleanup here (not in spawnWatcher) so
    // the sessions map stays owned by this module. Guarded: a restart (kill old →
    // start new) sets the new session before the old proc's exit fires, so only the
    // still-current session clears the marker.
    session.proc.onExit(() => {
      if (sessions.get(cwd) === session) {
        sessions.delete(cwd);
        fs.rmSync(session.liveFile, { force: true });
      }
    });
    sessions.set(cwd, session);
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

// Wait until the watcher accepts keystrokes (its idle prompt appeared). True when
// ready; false if it never got there — the caller should point at tail_log.
// ponytail: 60s boot ceiling; a big suite's cold start can exceed it — bump if seen.
export async function awaitReady(s) {
  return Promise.race([s.ready, sleep(60_000).then(() => false)]);
}
