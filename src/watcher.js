// Watcher process lifecycle: spawn one jest/vitest watch over a PTY, stop it the way
// a human would, and check whether a *different* live test-warden already owns a
// project's watch. Deals with a single watcher process and the OS (pty, tmp files,
// liveness marker) — the sessions map and orchestration over many live in session.js.
// Imports only core.js, so it never cycles with its callers.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommand, slugFor, watcherAlive, sleep } from "./core.js";

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

// Cross-process guard: is a *different*, still-alive test-warden already watching this
// project? A second file-watch on the same tree is a real perf hit — it can grind the
// machine to a halt — so we refuse rather than spawn a duplicate. Reuses the shared
// liveness check (same marker the hooks read); our own pid (a restart) reads as free.
// This pre-check isn't atomic, and two servers auto-starting on the same cwd at boot
// can collide — so spawnWatcher additionally claims the marker with O_EXCL; a lost
// race surfaces as a clean error there, never as a duplicate watcher.
export function watchedElsewhere(cwd) {
  const pid = watcherAlive(os.tmpdir(), slugFor(cwd));
  return pid === process.pid ? 0 : pid; // our own marker (restart) ⇒ free
}

// Spawn a jest/vitest watch over a PTY and return the session object (proc, rolling
// log, readiness promise, per-session file paths). Claims the liveness marker
// atomically before spawning so two servers can't double-watch one tree. Does NOT
// touch the sessions map — the caller registers the returned session and wires its
// exit cleanup, keeping that map owned by session.js.
export async function spawnWatcher({ runner, bin, cwd, args, env }) {
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
  // triggeredMtime 0: the results file was just deleted, so the watcher's initial
  // run counts as fresh the first time get_results waits on it.
  return {
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
