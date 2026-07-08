import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "nudge-watch.mjs",
);

// Build a temp monorepo: <root>/packages/api uses vitest; <root>/loose has no runner.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-"));
  const api = path.join(root, "packages", "api", "src");
  fs.mkdirSync(api, { recursive: true });
  fs.writeFileSync(
    path.join(root, "packages", "api", "package.json"),
    JSON.stringify({ devDependencies: { vitest: "^1" } }),
  );
  fs.writeFileSync(path.join(api, "x.ts"), "");
  const loose = path.join(root, "loose");
  fs.mkdirSync(loose, { recursive: true });
  fs.writeFileSync(path.join(loose, "y.ts"), "");
  return { root, apiFile: path.join(api, "x.ts"), looseFile: path.join(loose, "y.ts") };
}

// Run the hook with an isolated tmp dir and a fake edit of `file`; returns stdout.
const run = (tmp, file) =>
  execFileSync("node", [HOOK], {
    env: { ...process.env, TEST_WATCH_MCP_TMP: tmp },
    input: JSON.stringify({ tool_input: { file_path: file } }),
    encoding: "utf8",
  });

// Marker path for a (cwd, runner) watch; omit runner for the legacy runner-less slug.
const liveMarker = (tmp, cwd, runner) =>
  path.join(
    tmp,
    `test-warden-${crypto
      .createHash("sha1")
      .update(runner ? `${cwd}\0${runner}` : cwd)
      .digest("hex")
      .slice(0, 8)}.live`,
  );

// A package that has BOTH vitest and playwright: unit tests in src/, e2e in e2e/
// with the common custom-fixtures pattern (specs do NOT import @playwright/test).
function makeDualRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-dual-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      devDependencies: { vitest: "^1", "@playwright/test": "^1" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "playwright.config.ts"),
    'export default { testDir: "./e2e" };',
  );
  const e2e = path.join(root, "e2e");
  const src = path.join(root, "src");
  fs.mkdirSync(e2e);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(e2e, "todo.spec.ts"),
    'import { test, expect } from "./fixtures";', // no direct @playwright/test import
  );
  fs.writeFileSync(path.join(src, "unit.test.ts"), "");
  // direct import, but OUTSIDE testDir — content sniff must catch it
  fs.writeFileSync(
    path.join(src, "smoke.spec.ts"),
    'import { test } from "@playwright/test";',
  );
  return {
    root,
    e2eFile: path.join(e2e, "todo.spec.ts"),
    unitFile: path.join(src, "unit.test.ts"),
    strayFile: path.join(src, "smoke.spec.ts"),
  };
}

test("nudges to start_watch for the edited package, and keeps nudging until watched", () => {
  const { apiFile } = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));

  const out = run(tmp, apiFile);
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /start_watch/);
  assert.match(ctx, /packages\/api/);
  assert.match(ctx, /vitest/);

  // Still not watched → a later edit nudges again (the reliability fix).
  assert.match(run(tmp, apiFile), /start_watch/);
});

test("silent for a file outside any jest/vitest package", () => {
  const { looseFile } = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  assert.equal(run(tmp, looseFile).trim(), "");
});

test("silent when a live watcher marker exists for that package", () => {
  const { root, apiFile } = makeRepo();
  const cwd = path.join(root, "packages", "api");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  // Live session: marker holds an alive pid (this test process).
  fs.writeFileSync(liveMarker(tmp, cwd), String(process.pid));

  assert.equal(run(tmp, apiFile).trim(), "");
});

test("playwright: spec under testDir nudges playwright even without a direct import", () => {
  const { root, e2eFile } = makeDualRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  const ctx = JSON.parse(run(tmp, e2eFile)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /start_watch/);
  assert.match(ctx, /"playwright"/);
  assert.match(ctx, new RegExp(root));
});

test("playwright: direct @playwright/test import outside testDir nudges playwright", () => {
  const { strayFile } = makeDualRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  assert.match(
    JSON.parse(run(tmp, strayFile)).hookSpecificOutput.additionalContext,
    /"playwright"/,
  );
});

test("playwright: a unit file in the same dual package still nudges the unit runner", () => {
  const { unitFile } = makeDualRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  const ctx = JSON.parse(run(tmp, unitFile)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /"vitest"/);
  assert.doesNotMatch(ctx, /playwright/);
});

test("playwright: silent when its (cwd, runner) marker is live; unit edits still nudge", () => {
  const { root, e2eFile, unitFile } = makeDualRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  fs.writeFileSync(
    liveMarker(tmp, fs.realpathSync(root), "playwright"),
    String(process.pid),
  );
  assert.equal(run(tmp, e2eFile).trim(), ""); // e2e watched — no nudge
  assert.match(
    JSON.parse(run(tmp, unitFile)).hookSpecificOutput.additionalContext,
    /"vitest"/,
  ); // unit not watched — still nudges
});

test("nudges again when the marker's pid is dead (crashed server)", () => {
  const { root, apiFile } = makeRepo();
  const cwd = path.join(root, "packages", "api");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  const marker = liveMarker(tmp, cwd);
  fs.writeFileSync(marker, "2147483646"); // pid almost certainly not running

  assert.match(run(tmp, apiFile), /start_watch/);
  assert.equal(fs.existsSync(marker), false); // stale marker reaped
});
