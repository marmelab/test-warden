#!/usr/bin/env node
// PostToolUse hook: after any tool call, peek at the newest test-watch results
// file. If a *new* run completed and it's failing, surface a note to the agent.
// Non-blocking — the agent decides what to do. One note per run (deduped by mtime).
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { normalizeResults } from "../src/core.js";

// DIR defaults to the tmp dir the server writes to; overridable for tests only.
const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();
const STATE = path.join(DIR, "test-warden-notify-state");

// Newest test-warden-<pid>.json in tmp. ponytail: picks newest if several
// servers run at once — fine for the common single-server case.
function newestResults() {
  let best = null;
  for (const f of fs.readdirSync(DIR)) {
    if (!/^test-warden-\d+\.json$/.test(f)) continue;
    const p = path.join(DIR, f);
    const m = fs.statSync(p).mtimeMs;
    if (!best || m > best.m) best = { p, m };
  }
  return best;
}

// Plain text to stdout — the lowest common denominator every agent's command-hook
// system can capture. Non-blocking (exit 0). Note: Claude Code shows stdout in the
// transcript but only feeds stderr+exit-2 to the model, so on Claude this note is
// visible to the user, not auto-injected into context.
const emit = (text) => process.stdout.write(text + "\n");

const cur = newestResults();
if (!cur) process.exit(0); // no watch session

// Only fire once per completed run.
let last = 0;
try {
  last = Number(fs.readFileSync(STATE, "utf8")) || 0;
} catch {
  /* first run */
}
if (cur.m <= last) process.exit(0); // already reported this run
fs.writeFileSync(STATE, String(cur.m));

let res;
try {
  res = normalizeResults(JSON.parse(fs.readFileSync(cur.p, "utf8")));
} catch {
  process.exit(0); // mid-write / unreadable
}
if (res.ok) process.exit(0); // green — nothing to say

const names = res.failures.map((f) => `  • ${f.test}`).join("\n");
emit(
  `⚠️ test-watch: ${res.failed} test(s) failing (${res.suitesFailed} suite(s)).\n${names}\n` +
    `Call get_results for full failure messages.`,
);
process.exit(0);
