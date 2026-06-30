#!/usr/bin/env node
// PostToolUse hook: after any tool call, peek at each test-warden results file
// (one per watched workspace). For every file whose run is *new* since last check
// and failing, surface a note to the agent. Non-blocking — the agent decides.
// Deduped per file by mtime, so one workspace's pass can't mask another's fail.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { normalizeResults } from "../src/core.js";

// DIR defaults to the tmp dir the server writes to; overridable for tests only.
const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();
const STATE = path.join(DIR, "test-warden-notify-state");

// All test-warden-<pid>[-<slug>].json result files in tmp.
function resultFiles() {
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!/^test-warden-.+\.json$/.test(f)) continue;
    const p = path.join(DIR, f);
    out.push({ p, m: fs.statSync(p).mtimeMs });
  }
  return out;
}

// Plain text to stdout — the lowest common denominator every agent's command-hook
// system can capture. Non-blocking (exit 0). Note: Claude Code shows stdout in the
// transcript but only feeds stderr+exit-2 to the model, so on Claude this note is
// visible to the user, not auto-injected into context.
const emit = (text) => process.stdout.write(text + "\n");

let state = {}; // resultsFile -> last-reported mtime
try {
  state = JSON.parse(fs.readFileSync(STATE, "utf8")) || {};
} catch {
  /* first run */
}

const notes = [];
const next = {};
for (const { p, m } of resultFiles()) {
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
  emit(notes.join("\n") + "\nCall get_results for full failure messages.");
process.exit(0);
