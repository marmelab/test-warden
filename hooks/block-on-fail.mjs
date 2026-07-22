#!/usr/bin/env node
// Claude Code Stop hook: at the end of a turn, don't let the agent finish while a
// watched suite is red. For each live watcher, wait out any in-flight run (via the
// server's .running marker), then read its results; if any are failing, block the
// stop and hand the failures back so the agent fixes them this turn instead of the
// user discovering them next turn. Blocks at most once per turn — see stop_hook_active.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { normalizeResults, watcherAlive, sleep } from "../src/core.js";

const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();
const RUN_WAIT_MS = 15_000; // ceiling on waiting an in-flight run out
// ponytail: fixed 500ms covers the sub-perceptible fs-event→first-output gap (see
// session.js isRunning); bump if a slow runner still reads idle right after an edit.
const DEBOUNCE_MS = 500;

// Only running because a prior block already sent the agent back? Let it stop now —
// one forced round-trip, never a loop.
let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8")) || {};
} catch {
  /* no/invalid stdin */
}
if (input.stop_hook_active) process.exit(0);

// After an edit the runner has seen the change but its run may not have emitted output
// yet, so it still looks idle and the .running marker isn't up. Wait past that window
// or a run the agent's last edit triggered slips by as the previous run's stale green.
await sleep(DEBOUNCE_MS);

const slugs = fs
  .readdirSync(DIR)
  .map((f) => /^test-warden-([0-9a-f]+)\.json$/.exec(f)?.[1])
  .filter(Boolean);

const notes = [];
for (const slug of slugs) {
  if (!watcherAlive(DIR, slug)) continue; // dead session's leftovers — same gate as notify
  const running = path.join(DIR, `test-warden-${slug}.running`);
  const deadline = Date.now() + RUN_WAIT_MS;
  while (fs.existsSync(running) && Date.now() < deadline) await sleep(100);
  let res;
  try {
    res = normalizeResults(
      JSON.parse(fs.readFileSync(path.join(DIR, `test-warden-${slug}.json`), "utf8")),
    );
  } catch {
    continue; // no results yet, or mid-write — nothing to block on
  }
  if (res.ok) continue; // green — let it stop
  const names = res.failures.map((f) => `  • ${f.test} (${f.file})`).join("\n");
  notes.push(`Failed tests:\n${names}`);
}

if (notes.length)
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `${notes.join(
        "\n",
      )}\nTests are failing. Call test-warden \`get_results\` for details, fix them, then finish.`,
    }),
  );
process.exit(0);
