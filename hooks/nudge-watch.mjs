#!/usr/bin/env node
// Claude Code PostToolUse hook on Edit|Write: when you edit a file inside a dir that
// test-warden.config.js declares testable but that isn't being watched yet, nudge the
// agent to start_watch it. The config is the only source of truth (no detection):
// silent when the file is outside every configured dir or no config exists up the
// tree; an INVALID config is surfaced to the agent — it can fix it.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, slugFor, watcherAlive } from "../src/core.js";
import { emitContext } from "./emit.mjs";

const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();

// The edited file path arrives on stdin as the tool call's input.
let file;
try {
  file = JSON.parse(fs.readFileSync(0, "utf8"))?.tool_input?.file_path;
} catch {
  /* no/invalid stdin */
}
if (!file) process.exit(0);

// Deepest config entry whose dir contains the edited file. Walks up to the nearest
// test-warden.config.js (validated by loadConfig — same schema the server enforces).
async function findEntry(start) {
  for (let dir = path.dirname(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "test-warden.config.js"))) {
      const entries = await loadConfig(dir); // throws on invalid — caught below
      return entries
        .filter((e) => (start + path.sep).startsWith(e.dir + path.sep))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
    }
    if (path.dirname(dir) === dir) return null; // hit filesystem root — no config
  }
}

// Config entry dirs are realpath'd (loadConfig), so realpath the file to match.
let real = file;
try {
  real = fs.realpathSync(file);
} catch {
  /* freshly-written path oddity — use as-is */
}

let entry;
try {
  entry = await findEntry(real);
} catch (e) {
  // Broken config: the server would refuse this too — tell the agent so it gets fixed.
  emitContext(`🛡️ test-warden: ${e.message}`);
  process.exit(0);
}
if (!entry) process.exit(0); // outside every configured dir

// Re-checking liveness every edit (not nudging once) is what makes this reliable.
if (watcherAlive(DIR, slugFor(entry.dir))) process.exit(0); // already watched

emitContext(
  `🛡️ test-warden: tests in ${entry.dir} aren't being watched. ` +
    `Call start_watch { cwd: "${entry.dir}" } (runner: ${entry.runner}) for warm, fast test runs as you edit.`,
);
process.exit(0);
