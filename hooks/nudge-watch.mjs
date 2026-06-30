#!/usr/bin/env node
// Claude Code PostToolUse hook on Edit|Write: when you edit a file in a jest/vitest
// package that isn't being watched yet, nudge the agent to start_watch for that
// package. Fires once per package dir; silent if already watching or not a test package.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { detectRunner } from "../src/core.js";
import { emitContext } from "./emit.mjs";

const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();

// Is a watch actually alive for this cwd? The server writes a .live marker (pid)
// on start and removes it on exit; a leftover from a crashed server has a dead pid.
// Re-checking this every edit (instead of nudging once) is what makes it reliable.
function isWatched(cwd) {
  const slug = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  const live = path.join(DIR, `test-warden-${slug}.live`);
  let pid;
  try {
    pid = Number(fs.readFileSync(live, "utf8"));
  } catch {
    return false; // no marker — not watching
  }
  try {
    process.kill(pid, 0); // probe liveness; throws if the pid is gone
    return true;
  } catch {
    fs.rmSync(live, { force: true }); // stale marker from a dead server
    return false;
  }
}

// The edited file path arrives on stdin as the tool call's input.
let file;
try {
  file = JSON.parse(fs.readFileSync(0, "utf8"))?.tool_input?.file_path;
} catch {
  /* no/invalid stdin */
}
if (!file) process.exit(0);

// Walk up from the file to the nearest package that uses jest/vitest.
function findPackage(start) {
  for (let dir = path.dirname(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      let runner;
      try {
        runner = detectRunner(dir);
      } catch {
        runner = "ambiguous"; // both present — agent must pass runner
      }
      if (runner) return { cwd: dir, runner };
    }
    if (path.dirname(dir) === dir) return null; // hit filesystem root
  }
}

const pkg = findPackage(file);
if (!pkg) process.exit(0); // not inside a jest/vitest package

if (isWatched(pkg.cwd)) process.exit(0); // already watched — nothing to nudge

const runnerNote =
  pkg.runner === "ambiguous"
    ? "jest and vitest are both present — pass runner explicitly"
    : `runner: ${pkg.runner}`;
emitContext(
  `🛡️ test-warden: tests in ${pkg.cwd} aren't being watched. ` +
    `Call start_watch { cwd: "${pkg.cwd}" } (${runnerNote}) for warm, fast test runs as you edit.`,
);
process.exit(0);
