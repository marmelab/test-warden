import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "block-on-fail.mjs",
);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "twm-block-test-"));
const SLUG = "abcd1234";
const resultsFile = path.join(TMP, `test-warden-${SLUG}.json`);
const liveMarker = path.join(TMP, `test-warden-${SLUG}.live`);
const runningMarker = path.join(TMP, `test-warden-${SLUG}.running`);

// Run the hook with an isolated tmp dir and the given stdin; returns stdout.
const run = (input = "{}") =>
  execFileSync("node", [HOOK], {
    env: { ...process.env, TEST_WATCH_MCP_TMP: TMP },
    input,
    encoding: "utf8",
  });

const markLive = () => fs.writeFileSync(liveMarker, `${process.pid}\n${TMP}`);
const failing = {
  numTotalTests: 1,
  numFailedTests: 1,
  numFailedTestSuites: 1,
  testResults: [
    { name: "/p/a.test.js", assertionResults: [{ status: "failed", title: "boom" }] },
  ],
};
const passing = { numTotalTests: 1, numFailedTests: 0, numFailedTestSuites: 0, testResults: [] };

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("blocks the stop on a failing run, pointing at the failures", () => {
  markLive();
  fs.rmSync(runningMarker, { force: true });
  fs.writeFileSync(resultsFile, JSON.stringify(failing));
  const out = JSON.parse(run());
  assert.equal(out.decision, "block");
  assert.match(out.reason, /boom/);
  assert.match(out.reason, /get_results/);
});

test("lets the stop through on a passing run", () => {
  markLive();
  fs.rmSync(runningMarker, { force: true });
  fs.writeFileSync(resultsFile, JSON.stringify(passing));
  assert.equal(run().trim(), "");
});

test("does not block twice — stop_hook_active lets the agent finish", () => {
  markLive();
  fs.rmSync(runningMarker, { force: true });
  fs.writeFileSync(resultsFile, JSON.stringify(failing));
  assert.equal(run('{"stop_hook_active":true}').trim(), "");
});

test("ignores a failing run with no live watcher (orphaned session)", () => {
  fs.rmSync(liveMarker, { force: true });
  fs.rmSync(runningMarker, { force: true });
  fs.writeFileSync(resultsFile, JSON.stringify(failing));
  assert.equal(run().trim(), "");
});

test("waits out an in-flight run before judging", () => {
  markLive();
  // Marker present ⇒ a run is in flight; stale (green) JSON on disk. The hook must wait
  // for the marker to clear and read the fresh (failing) result, not the stale green.
  fs.writeFileSync(resultsFile, JSON.stringify(passing));
  fs.writeFileSync(runningMarker, "");
  // A separate process clears the marker + writes the failing result mid-wait: the
  // hook's run() below blocks this process (execFileSync), so the clear must be its
  // own OS process to actually run concurrently.
  const clear = `require("fs").writeFileSync(${JSON.stringify(resultsFile)}, ${JSON.stringify(
    JSON.stringify(failing),
  )}); require("fs").rmSync(${JSON.stringify(runningMarker)}, { force: true });`;
  spawn("node", ["-e", `setTimeout(() => { ${clear} }, 700)`], { stdio: "ignore" });
  const out = JSON.parse(run());
  assert.equal(out.decision, "block");
  assert.match(out.reason, /boom/);
});
