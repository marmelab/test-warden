import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resultsMtime, markTriggered, waitForResults } from "../src/results.js";

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
