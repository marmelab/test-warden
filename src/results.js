// Test-results polling: read whichever reporter (jest's reporter API / vitest's json
// reporter) wrote the per-session results file, normalize it, and block until a
// freshly-triggered run's output lands. Operates on the passed-in session object —
// knows nothing about the sessions map or the pty.
import fs from "node:fs";
import { normalizeResults, sleep } from "./core.js";

// Both jest's reporter and vitest's --outputFile rewrite the results file on every
// run, so a rising mtime is the "a new run finished" edge waitForResults keys on
// (0 when no run has landed).
// ponytail: relies on sub-second mtime (ext4/xfs/apfs have it); on a 1s-granularity
// FS a rerun finishing within the same second as the trigger reads as stale. Move
// to a run counter written by the reporter if that ever bites.
export function resultsMtime(s) {
  try {
    return fs.statSync(s.resultsFile).mtimeMs;
  } catch {
    return 0;
  }
}

// Record the trigger floor: waitForResults only trusts JSON whose mtime beats it.
// Defaults to the file's current mtime (right for a run WE trigger — the previous
// run's JSON is what's on disk). Callers reacting to a run already in flight must
// pass the last-idle mtime instead: that run may have ALREADY written, so flooring
// at the current mtime would wait for a write that never comes (see get_results).
export function markTriggered(s, mtime = resultsMtime(s)) {
  s.triggeredMtime = mtime;
  s.lastActivity = Date.now();
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

// Block until the watch's in-flight run lands, rather than returning pending and making
// the agent poll. Trust the JSON only once its mtime advanced past the trigger (a fresh
// run) and it parses (not mid-write). Returns the summary, or null if still running.
// ponytail: 30s default ceiling so we return before a typical MCP client request
// timeout; overridable via timeoutMs (tests pass a small one; bump for a slow suite).
export async function waitForResults(s, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = resultsMtime(s) > s.triggeredMtime ? readResults(s) : null;
    if (res) return res;
    await sleep(100);
  }
  return null;
}
