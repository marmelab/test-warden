#!/usr/bin/env node
// Claude Code PostToolUse hook on Edit|Write: when you edit a file in a
// jest/vitest/playwright package that isn't being watched yet, nudge the agent to
// start_watch for that package. Fires once per (package dir, runner); silent if
// already watching or not a test package.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  detectPlaywright,
  detectRunner,
  playwrightTestDir,
  slugFor,
  watcherAlive,
} from "../src/core.js";
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

// Is `file` a playwright test for the package at `dir`? Location first (that's how
// playwright itself decides, and most specs import a custom fixtures module rather
// than @playwright/test), content sniff as fallback for specs outside testDir.
function isPlaywrightTest(dir, f) {
  if (!detectPlaywright(dir)) return false;
  const testDir = playwrightTestDir(dir);
  if (testDir && (f === testDir || f.startsWith(testDir + path.sep))) return true;
  try {
    // ponytail: capped plain read — imports sit at the top, and this only runs on
    // the rare not-yet-watched path (the liveness check below exits first).
    return fs
      .readFileSync(f, "utf8")
      .slice(0, 65536)
      .includes("@playwright/test");
  } catch {
    return false;
  }
}

// Walk up from the file to the nearest package that uses a supported runner.
// Playwright is checked per FILE (a package legitimately has unit + e2e side by
// side), the unit runners per package.
function findPackage(start) {
  for (let dir = path.dirname(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      if (isPlaywrightTest(dir, start)) return { cwd: dir, runner: "playwright" };
      let runner;
      try {
        runner = detectRunner(dir);
      } catch {
        runner = "ambiguous"; // jest AND vitest — agent must pass runner
      }
      if (runner) return { cwd: dir, runner };
    }
    if (path.dirname(dir) === dir) return null; // hit filesystem root
  }
}

const pkg = findPackage(file);
if (!pkg) process.exit(0); // not inside a supported test package

// Re-checking liveness every edit (not nudging once) is what makes this reliable.
// A watch is keyed by (cwd, runner); "ambiguous" probes both unit slugs, and the
// legacy runner-less slug keeps markers from pre-runner-keyed servers honored.
const slugs = (
  pkg.runner === "ambiguous" ? ["jest", "vitest"] : [pkg.runner]
).map((r) => slugFor(pkg.cwd, r));
slugs.push(slugFor(pkg.cwd));
if (slugs.some((slug) => watcherAlive(DIR, slug))) process.exit(0); // already watched

const call =
  pkg.runner === "ambiguous"
    ? `start_watch { cwd: "${pkg.cwd}" } (jest and vitest are both present — pass runner explicitly)`
    : `start_watch { cwd: "${pkg.cwd}", runner: "${pkg.runner}" }`;
emitContext(
  `🛡️ test-warden: ${pkg.runner === "playwright" ? "e2e tests" : "tests"} in ${pkg.cwd} aren't being watched. ` +
    `Call ${call} for warm, fast test runs as you edit.`,
);
process.exit(0);
