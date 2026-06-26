import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommand, normalizeResults } from "../src/core.js";

test("buildCommand: jest keeps positional args before the greedy --reporters", () => {
  const cmd = buildCommand("jest", "/tmp/out.json", "/r.cjs", "src/foo");
  // args must sit before --reporters, else jest reads them as reporter modules.
  assert.match(cmd, /--watchAll src\/foo --reporters default --reporters \/r\.cjs$/);
});

test("buildCommand: jest without extra args", () => {
  const cmd = buildCommand("jest", "/tmp/out.json", "/r.cjs");
  assert.match(cmd, /jest --watchAll --reporters default --reporters \/r\.cjs$/);
});

test("buildCommand: vitest wires json output file and appends args", () => {
  const cmd = buildCommand("vitest", "/tmp/out.json", "/r.cjs", "src/foo");
  assert.match(cmd, /--reporter=json --outputFile=\/tmp\/out\.json src\/foo$/);
});

// jest's AggregatedResult and vitest's json reporter emit the same shape; the
// server parses both via normalizeResults. One fixture covers both runners.
const SAMPLE = {
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 2,
  numFailedTestSuites: 1,
  testResults: [
    {
      name: "/proj/a.test.js",
      assertionResults: [
        { status: "passed", title: "adds", fullName: "math adds" },
        {
          status: "failed",
          title: "subtracts",
          fullName: "math subtracts",
          failureMessages: ["Expected 1 got 2"],
        },
      ],
    },
    {
      name: "/proj/b.test.js",
      assertionResults: [
        { status: "failed", title: "throws", failureMessages: ["boom"] },
      ],
    },
  ],
};

test("normalizeResults: counts and ok flag", () => {
  const r = normalizeResults(SAMPLE);
  assert.equal(r.total, 3);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 2);
  assert.equal(r.suitesFailed, 1);
  assert.equal(r.ok, false);
});

test("normalizeResults: extracts only failures with file + message", () => {
  const r = normalizeResults(SAMPLE);
  assert.equal(r.failures.length, 2);
  assert.deepEqual(r.failures[0], {
    test: "math subtracts",
    file: "/proj/a.test.js",
    message: "Expected 1 got 2",
  });
  // falls back to title when fullName is absent
  assert.equal(r.failures[1].test, "throws");
});

// Jest's reporter-API AggregatedResult nests per-test results under `testResults`
// (not `assertionResults`) and names the file `testFilePath` (not `name`).
test("normalizeResults: handles jest reporter-API shape", () => {
  const r = normalizeResults({
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    numFailedTestSuites: 1,
    testResults: [
      {
        testFilePath: "/proj/a.test.js",
        testResults: [
          { status: "passed", title: "ok", fullName: "g ok" },
          {
            status: "failed",
            title: "bad",
            fullName: "g bad",
            failureMessages: ["nope"],
          },
        ],
      },
    ],
  });
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failures, [
    { test: "g bad", file: "/proj/a.test.js", message: "nope" },
  ]);
});

test("normalizeResults: all-green run is ok with no failures", () => {
  const r = normalizeResults({
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: [],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failures, []);
});

test("normalizeResults: missing fields default to zero, not crash", () => {
  const r = normalizeResults({});
  assert.deepEqual(r, {
    total: 0,
    passed: 0,
    failed: 0,
    suitesFailed: 0,
    ok: true,
    failures: [],
  });
});

test("normalizeResults: caps a huge failure message at 2000 chars", () => {
  const r = normalizeResults({
    testResults: [
      {
        name: "x.js",
        assertionResults: [
          { status: "failed", title: "big", failureMessages: ["x".repeat(5000)] },
        ],
      },
    ],
  });
  assert.equal(r.failures[0].message.length, 2000);
});
