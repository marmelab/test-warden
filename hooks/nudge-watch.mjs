#!/usr/bin/env node
// Claude Code PostToolUse hook on Edit|Write: surface a broken test-warden.config.js
// to the agent. An invalid or unparseable config makes the server exit at startup
// (process.exit(1)), so there are NO test-warden tools — this hook, running
// independently of the server, is the only agent-facing signal that tests aren't
// being watched and why. A valid config needs no nudge: the server auto-starts every
// configured watch at boot. Silent when the edit is nowhere near a config, or the
// config is fine.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/core.js";
import { emitContext } from "./emit.mjs";

// The edited file path arrives on stdin as the tool call's input.
let file;
try {
  file = JSON.parse(fs.readFileSync(0, "utf8"))?.tool_input?.file_path;
} catch {
  /* no/invalid stdin */
}
if (!file) process.exit(0);

// Nearest test-warden.config.js at or above the edited file, or null at the root.
function nearestConfigDir(start) {
  for (let dir = path.dirname(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "test-warden.config.js"))) return dir;
    if (path.dirname(dir) === dir) return null; // hit filesystem root — no config
  }
}

const dir = nearestConfigDir(file);
if (!dir) process.exit(0); // no config up the tree — nothing to validate

try {
  await loadConfig(dir); // throws on invalid — same schema the server enforces
} catch (e) {
  // Broken config: the server refused to boot on this too — tell the agent so it gets fixed.
  emitContext(`🛡️ test-warden: ${e.message}`);
}
process.exit(0);
