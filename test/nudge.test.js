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

test("nudges to start_watch for the edited package, once", () => {
  const { apiFile } = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));

  const out = run(tmp, apiFile);
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /start_watch/);
  assert.match(ctx, /packages\/api/);
  assert.match(ctx, /vitest/);

  // Second edit in the same package → deduped, no output.
  assert.equal(run(tmp, apiFile).trim(), "");
});

test("silent for a file outside any jest/vitest package", () => {
  const { looseFile } = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  assert.equal(run(tmp, looseFile).trim(), "");
});

test("silent when a watcher for that package already exists", () => {
  const { root, apiFile } = makeRepo();
  const cwd = path.join(root, "packages", "api");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-tmp-"));
  // Simulate an active session: its results file is named by a hash of cwd.
  const slug = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  fs.writeFileSync(path.join(tmp, `test-warden-999-${slug}.json`), "{}");

  assert.equal(run(tmp, apiFile).trim(), "");
});
