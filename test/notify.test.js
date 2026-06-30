import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "notify-on-fail.mjs",
);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "twm-notify-test-"));
const resultsFile = path.join(TMP, "test-warden-99999.json");

// Run the hook with an isolated tmp dir; returns its stdout.
const run = () =>
  execFileSync("node", [HOOK], {
    env: { ...process.env, TEST_WATCH_MCP_TMP: TMP },
    input: "{}",
    encoding: "utf8",
  });

const writeResults = (blob, mtimeMs) => {
  fs.writeFileSync(resultsFile, JSON.stringify(blob));
  if (mtimeMs) fs.utimesSync(resultsFile, mtimeMs / 1000, mtimeMs / 1000);
};

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("notifies once on a failing run, then stays silent (deduped by mtime)", () => {
  writeResults(
    {
      numTotalTests: 2,
      numFailedTests: 1,
      numFailedTestSuites: 1,
      testResults: [
        {
          name: "/p/a.test.js",
          assertionResults: [
            { status: "failed", title: "boom", failureMessages: ["x"] },
          ],
        },
      ],
    },
    2_000_000_000_000,
  );

  const first = run();
  assert.match(first, /1 test\(s\) failing/);
  assert.match(first, /boom/);

  // Same run (same mtime) → no repeat notification.
  assert.equal(run().trim(), "");
});

test("stays silent on a passing run", () => {
  writeResults(
    {
      numTotalTests: 2,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: [],
    },
    2_000_000_001_000, // newer mtime so it's seen as a fresh run
  );
  assert.equal(run().trim(), "");
});
