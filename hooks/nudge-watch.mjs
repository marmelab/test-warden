#!/usr/bin/env node
// PostToolUse hook on Edit|Write: when you edit a file in a jest/vitest package
// that isn't being watched yet, nudge the agent to start_watch for that package.
// Fires once per package dir; silent if already watching or not a test package.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { detectRunner } from "../src/core.js";

const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();
const STATE = path.join(DIR, "test-warden-nudge-state");

// Claude Code reads PostToolUse additionalContext (this JSON envelope) into the
// model's context — required here, since the point is to prompt a tool call. (The
// notify hook uses plain text because being merely user-visible is enough there.)
const emit = (text) =>
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: text,
      },
    }),
  );

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

// Already watching this cwd? Its results file (named by a hash of cwd) exists.
const slug = crypto.createHash("sha1").update(pkg.cwd).digest("hex").slice(0, 8);
if (fs.readdirSync(DIR).some((f) => f.includes(slug) && f.endsWith(".json")))
  process.exit(0);

// Nudge once per package dir.
let nudged = [];
try {
  nudged = JSON.parse(fs.readFileSync(STATE, "utf8")) || [];
} catch {
  /* first nudge */
}
if (nudged.includes(pkg.cwd)) process.exit(0);
fs.writeFileSync(STATE, JSON.stringify([...nudged, pkg.cwd]));

const runnerNote =
  pkg.runner === "ambiguous"
    ? "jest and vitest are both present — pass runner explicitly"
    : `runner: ${pkg.runner}`;
emit(
  `🛡️ test-warden: tests in ${pkg.cwd} aren't being watched. ` +
    `Call start_watch { cwd: "${pkg.cwd}" } (${runnerNote}) for warm, fast test runs as you edit.`,
);
process.exit(0);
