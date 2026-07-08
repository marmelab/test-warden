import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCommand,
  detectPlaywright,
  detectRunner,
  playwrightTestDir,
  resolveBin,
  parseScriptEnv,
  normalizeResults,
  slugFor,
} from "../src/core.js";

test("slugFor: same dir via trailing slash or symlink yields one slug", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-slug-"));
  const link = `${dir}-link`;
  fs.symlinkSync(dir, link);
  const base = slugFor(dir);
  assert.equal(slugFor(`${dir}/`), base); // trailing slash collapses
  assert.equal(slugFor(link), base); // symlink resolves to the same real path
  fs.rmSync(link, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("slugFor: same dir + different runner yields distinct, stable slugs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-slug-"));
  const unit = slugFor(dir, "vitest");
  const e2e = slugFor(dir, "playwright");
  assert.notEqual(unit, e2e); // one watcher per (cwd, runner) pair
  assert.notEqual(unit, slugFor(dir)); // runner-less (legacy) slug is its own key
  assert.equal(slugFor(`${dir}/`, "vitest"), unit); // canonicalization still applies
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseScriptEnv: pulls leading env assignments off the test script", () => {
  assert.deepEqual(parseScriptEnv("TZ=UTC jest"), { TZ: "UTC" });
  assert.deepEqual(parseScriptEnv("TZ=UTC LANG=en_US vitest run"), {
    TZ: "UTC",
    LANG: "en_US",
  });
  // cross-env prefix and quoted values
  assert.deepEqual(parseScriptEnv('cross-env TZ="America/New_York" jest'), {
    TZ: "America/New_York",
  });
  assert.deepEqual(parseScriptEnv("cross-env-shell FOO='a b' jest"), {
    FOO: "a b",
  });
  // no assignments / empty
  assert.deepEqual(parseScriptEnv("vitest run"), {});
  assert.deepEqual(parseScriptEnv(undefined), {});
});

test("buildCommand: jest keeps positional args before the greedy --reporters", () => {
  const cmd = buildCommand("jest", "/bin/jest", "/tmp/out.json", "/r.cjs", "src/foo");
  // args must sit before --reporters, else jest reads them as reporter modules.
  assert.match(cmd, /--watch src\/foo --reporters default --reporters "\/r\.cjs"$/);
});

test("buildCommand: jest without extra args", () => {
  const cmd = buildCommand("jest", "/bin/jest", "/tmp/out.json", "/r.cjs");
  assert.match(cmd, /jest" --watch --reporters default --reporters "\/r\.cjs"$/);
});

test("buildCommand: vitest scopes startup to changed files and wires json output", () => {
  const cmd = buildCommand("vitest", "/bin/vitest", "/tmp/out.json", "/r.cjs", "src/foo");
  assert.match(cmd, /--watch --changed --reporter=default/);
  assert.match(cmd, /--reporter=json --outputFile="\/tmp\/out\.json" src\/foo$/);
});

test("buildCommand: quotes paths with spaces", () => {
  const cmd = buildCommand(
    "vitest",
    "/My Apps/p/node_modules/.bin/vitest",
    "/tmp dir/out.json",
    "/r.cjs",
  );
  assert.match(cmd, /^"\/My Apps\/p\/node_modules\/\.bin\/vitest" /);
  assert.match(cmd, /--outputFile="\/tmp dir\/out\.json"/);
});

test("detectRunner: from deps, config files, neither, and ambiguous", () => {
  const mk = (setup) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twm-detect-"));
    setup(dir);
    return dir;
  };
  const pkg = (dir, obj) =>
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(obj));

  assert.equal(detectRunner(mk((d) => pkg(d, { devDependencies: { vitest: "^1" } }))), "vitest");
  assert.equal(detectRunner(mk((d) => pkg(d, { devDependencies: { jest: "^29" } }))), "jest");
  // config file alone, no package.json dep
  assert.equal(detectRunner(mk((d) => fs.writeFileSync(path.join(d, "vitest.config.ts"), ""))), "vitest");
  // jest config under the package.json key
  assert.equal(detectRunner(mk((d) => pkg(d, { jest: {} }))), "jest");
  // neither → null
  assert.equal(detectRunner(mk((d) => pkg(d, {}))), null);
  assert.equal(detectRunner(mk(() => {})), null); // no package.json at all
  // both → throws so the caller asks for an explicit runner
  assert.throws(() => detectRunner(mk((d) => pkg(d, { devDependencies: { jest: "^29", vitest: "^1" } }))), /both/i);
});

test("detectPlaywright: dep or config file, independent of the unit runner", () => {
  const mk = (setup) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twm-pw-"));
    setup(dir);
    return dir;
  };
  const pkg = (dir, obj) =>
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(obj));

  assert.equal(detectPlaywright(mk((d) => pkg(d, { devDependencies: { "@playwright/test": "^1" } }))), true);
  assert.equal(detectPlaywright(mk((d) => fs.writeFileSync(path.join(d, "playwright.config.ts"), ""))), true);
  assert.equal(detectPlaywright(mk((d) => pkg(d, { devDependencies: { vitest: "^1" } }))), false);
  assert.equal(detectPlaywright(mk(() => {})), false);
  // coexistence: playwright alongside a unit runner is NOT ambiguous —
  // detectRunner still answers for the unit side, detectPlaywright for e2e
  const both = mk((d) =>
    pkg(d, { devDependencies: { vitest: "^1", "@playwright/test": "^1" } }),
  );
  assert.equal(detectPlaywright(both), true);
  assert.equal(detectRunner(both), "vitest");
});

test("playwrightTestDir: extracts a literal testDir, else null", () => {
  const mk = (name, content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twm-pwdir-"));
    if (name) fs.writeFileSync(path.join(dir, name), content);
    return dir;
  };
  // double quotes, single quotes, ts config
  let d = mk("playwright.config.js", 'export default defineConfig({ testDir: "./e2e" });');
  assert.equal(playwrightTestDir(d), path.join(d, "e2e"));
  d = mk("playwright.config.ts", "export default defineConfig({\n  testDir: './tests/e2e',\n});");
  assert.equal(playwrightTestDir(d), path.join(d, "tests/e2e"));
  // no testDir literal (computed or absent) → null
  assert.equal(playwrightTestDir(mk("playwright.config.js", "export default {}")), null);
  assert.equal(playwrightTestDir(mk("playwright.config.js", "const dir = x; export default { testDir: dir }")), null);
  // no config at all → null
  assert.equal(playwrightTestDir(mk(null)), null);
});

test("resolveBin: walks up to a hoisted node_modules/.bin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twm-bin-"));
  const bin = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "vitest"), "");
  const pkgDir = path.join(root, "packages", "app");
  fs.mkdirSync(pkgDir, { recursive: true });

  assert.equal(resolveBin(pkgDir, "vitest"), path.join(bin, "vitest")); // found at root
  assert.equal(resolveBin(pkgDir, "jest"), null); // absent everywhere up the tree
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
