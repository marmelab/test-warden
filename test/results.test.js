import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resultsMtime, markTriggered, waitForResults } from "../src/results.js";
import { isRunning } from "../src/session.js";

// A minimal stand-in for a watch session: the results functions only ever touch
// s.resultsFile and s.triggeredMtime, never the pty or the sessions map.
function fakeSession() {
  const resultsFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "tw-results-")),
    "out.json",
  );
  return { resultsFile, triggeredMtime: 0 };
}

const VITEST_SHAPE = {
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  numFailedTestSuites: 1,
  testResults: [
    {
      name: "/proj/a.test.js",
      assertionResults: [
        { status: "passed", title: "ok", fullName: "a ok" },
        {
          status: "failed",
          title: "bad",
          fullName: "a bad",
          failureMessages: ["boom"],
        },
      ],
    },
  ],
};

test("resultsMtime: 0 before any run, the file mtime after", () => {
  const s = fakeSession();
  assert.equal(resultsMtime(s), 0); // no file yet
  fs.writeFileSync(s.resultsFile, "{}");
  assert.ok(resultsMtime(s) > 0);
});

test("markTriggered: snapshots the current mtime and bumps activity", () => {
  const s = fakeSession();
  fs.writeFileSync(s.resultsFile, "{}");
  markTriggered(s);
  assert.equal(s.triggeredMtime, resultsMtime(s));
  assert.ok(s.lastActivity <= Date.now());
});

test("waitForResults: returns the normalized summary once a fresh run lands", async () => {
  const s = fakeSession();
  fs.writeFileSync(s.resultsFile, JSON.stringify(VITEST_SHAPE)); // mtime > 0 = fresh vs trigger 0
  const res = await waitForResults(s);
  assert.equal(res.total, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.ok, false);
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].file, "/proj/a.test.js");
});

test("waitForResults: never returns the previous run's stale JSON — only a fresher one", async () => {
  const s = fakeSession();
  // A completed prior run sits in the file, and the session was triggered at its mtime:
  // nothing fresh has landed yet, so the leftover JSON must NOT be returned.
  fs.writeFileSync(s.resultsFile, JSON.stringify(VITEST_SHAPE));
  const staleMtime = resultsMtime(s);
  s.triggeredMtime = staleMtime;

  // A fresh run lands mid-wait with a newer mtime and different counts.
  const fresh = {
    numTotalTests: 5,
    numPassedTests: 5,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: [],
  };
  setTimeout(() => {
    fs.writeFileSync(s.resultsFile, JSON.stringify(fresh));
    const bumped = (staleMtime + 1000) / 1000;
    fs.utimesSync(s.resultsFile, bumped, bumped); // guarantee mtime advances past the trigger
  }, 150);

  const res = await waitForResults(s, 5_000);
  assert.equal(res.total, 5); // the fresh run, never the stale 2-test one
  assert.equal(res.ok, true);
});

test("get_results contract: run already wrote before its idle prompt — return it, don't pend", async () => {
  const s = fakeSession();
  // The in-flight run has ALREADY written its JSON, but the idle prompt hasn't printed
  // yet, so isRunning is still true. Flooring at the CURRENT mtime would wait for a
  // write that never comes (30s pending); flooring at the last-idle mtime returns the
  // run that just landed. This is the window a plain markTriggered(s) got wrong.
  fs.writeFileSync(
    s.resultsFile,
    JSON.stringify({
      numTotalTests: 5,
      numPassedTests: 5,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: [],
    }),
  );
  const currentMtime = resultsMtime(s);
  s.idleResultsMtime = currentMtime - 1; // the last idle saw an older run
  s.idleAt = 1000;
  s.lastOutputAt = 2000; // mid-run: output since the last idle
  assert.equal(isRunning(s), true);

  markTriggered(s, s.idleResultsMtime); // get_results' rule when running
  const res = await waitForResults(s, 250); // short: must return now, not ride the deadline
  assert.equal(res.total, 5);
  assert.equal(res.ok, true);
});

test("waitForResults: returns null when no fresh run lands within the timeout", async () => {
  const s = fakeSession();
  // File present but stale vs the trigger — nothing newer will land, so the poll loop
  // must hit its deadline and return null (the "still running after Ns" signal).
  fs.writeFileSync(s.resultsFile, JSON.stringify(VITEST_SHAPE));
  s.triggeredMtime = resultsMtime(s);
  assert.equal(await waitForResults(s, 250), null);
});

test("isRunning: true once output arrives after the idle prompt, false when idle catches up", () => {
  const s = { idleAt: 2000, lastOutputAt: 2000 }; // idle prompt is the latest thing seen
  assert.equal(isRunning(s), false);
  s.lastOutputAt = 2500; // a rerun's output arrived after idle
  assert.equal(isRunning(s), true);
  s.idleAt = 3000; // idle prompt reprinted ⇒ run finished
  assert.equal(isRunning(s), false);
});

test("get_results contract: mid-run, wait for the fresh results — never the stale run", async () => {
  const s = fakeSession();
  // The previous run's JSON (2 tests, 1 failed) is on disk, and the watcher is mid-run
  // (output has arrived since the last idle prompt) — the edit-then-get_results race.
  fs.writeFileSync(s.resultsFile, JSON.stringify(VITEST_SHAPE));
  s.idleAt = 1000;
  s.lastOutputAt = 2000;
  assert.equal(isRunning(s), true);

  // get_results' rule when running: snapshot now, then hold out for a newer write.
  markTriggered(s);

  // The in-flight run completes with fresh, all-green results.
  setTimeout(() => {
    fs.writeFileSync(
      s.resultsFile,
      JSON.stringify({
        numTotalTests: 5,
        numPassedTests: 5,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        testResults: [],
      }),
    );
    const bumped = (resultsMtime(s) + 1000) / 1000;
    fs.utimesSync(s.resultsFile, bumped, bumped);
  }, 150);

  const res = await waitForResults(s, 5_000);
  assert.equal(res.total, 5); // the fresh run, never the stale 2-test one
  assert.equal(res.ok, true);
});
