#!/usr/bin/env node
// Claude Code PostToolUse hook: after any tool call, peek at each test-warden results
// file (one per watched workspace). For every file backed by a *live* watcher whose run
// is *new* since last check and failing, inject a note into the agent's context.
// Non-blocking — the agent decides. Deduped per file by mtime, so one workspace's pass
// can't mask another's fail. Results with no live watcher are stale leftovers from a
// dead session — reaped here, never reported (else notify contradicts nudge).
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { normalizeResults, watcherAlive } from "../src/core.js";
import { emitContext } from "./emit.mjs";

// DIR defaults to the tmp dir the server writes to; overridable for tests only.
const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();
const STATE = path.join(DIR, "test-warden-notify-state");

// All test-warden-<pid>-<slug>.json result files in DIR, tagged with their slug.
function resultFiles() {
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    const match = /^test-warden-\d+-([0-9a-f]+)\.json$/.exec(f);
    if (!match) continue;
    const p = path.join(DIR, f);
    out.push({ p, m: fs.statSync(p).mtimeMs, slug: match[1] });
  }
  return out;
}

let state = {}; // resultsFile -> last-reported mtime
try {
  state = JSON.parse(fs.readFileSync(STATE, "utf8")) || {};
} catch {
  /* first run */
}

const notes = [];
const next = {};
for (const { p, m, slug } of resultFiles()) {
  // Same source of truth as nudge: no live watcher ⇒ these results are orphaned by a
  // dead session. Reap them so they can't masquerade as a fresh failure — the bug where
  // notify shouted "failing" for a dir nudge (correctly) called "not watched".
  if (!watcherAlive(DIR, slug)) {
    fs.rmSync(p, { force: true });
    continue;
  }
  next[p] = m; // rebuild state from live files (prunes dead sessions)
  if (m <= (state[p] || 0)) continue; // already reported this run
  let res;
  try {
    res = normalizeResults(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    next[p] = state[p] || 0; // mid-write — don't mark as seen, retry next time
    continue;
  }
  if (res.ok) continue; // green — nothing to say
  const names = res.failures.map((f) => `  • ${f.test} (${f.file})`).join("\n");
  notes.push(
    `⚠️ test-warden: ${res.failed} test(s) failing (${res.suitesFailed} suite(s)).\n${names}`,
  );
}

fs.writeFileSync(STATE, JSON.stringify(next));
if (notes.length)
  emitContext(
    notes.join("\n") +
      "\n→ That's only the failing test names. For the actual assertion errors and " +
      "stack traces, call the test-warden `get_results` tool before fixing — don't " +
      "infer the cause from the names above.",
  );
process.exit(0);
