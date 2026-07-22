import { test } from "node:test";
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
  "nudge-watch.mjs",
);

// Build a temp monorepo driven by test-warden.config.js: <root>/packages/api is the
// only configured dir; <root>/loose has a vitest package.json but NO config entry —
// proving the hook follows the config, not detection.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-"));
  fs.writeFileSync(
    path.join(root, "test-warden.config.js"),
    'module.exports = [{ dir: "packages/api", runner: "vitest" }];',
  );
  const api = path.join(root, "packages", "api", "src");
  fs.mkdirSync(api, { recursive: true });
  fs.writeFileSync(path.join(api, "x.ts"), "");
  const loose = path.join(root, "loose");
  fs.mkdirSync(loose, { recursive: true });
  fs.writeFileSync(
    path.join(loose, "package.json"),
    JSON.stringify({ devDependencies: { vitest: "^1" } }),
  );
  fs.writeFileSync(path.join(loose, "y.ts"), "");
  return { root, apiFile: path.join(api, "x.ts"), looseFile: path.join(loose, "y.ts") };
}

// Run the hook with a fake edit of `file`; returns stdout.
const run = (file) =>
  execFileSync("node", [HOOK], {
    input: JSON.stringify({ tool_input: { file_path: file } }),
    encoding: "utf8",
  });

test("silent for a valid config — the server auto-starts the watch at boot", () => {
  const { apiFile } = makeRepo();
  // Editing a file under a configured dir with a valid config needs no nudge: the
  // watch is already running (auto-started at boot), so the hook stays quiet.
  assert.equal(run(apiFile).trim(), "");
});

test("silent for a file whose nearest config is valid, even outside every entry's dir", () => {
  const { looseFile } = makeRepo();
  // loose/ has a vitest package.json but no config entry — there's no detection
  // fallback, and the root config it finds is valid, so nothing to surface.
  assert.equal(run(looseFile).trim(), "");
});

test("silent when no config exists up the tree", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "twm-nudge-bare-"));
  const file = path.join(bare, "z.ts");
  fs.writeFileSync(file, "");
  assert.equal(run(file).trim(), "");
});

test("surfaces an invalid config to the agent", () => {
  const { root, apiFile } = makeRepo();
  fs.writeFileSync(
    path.join(root, "test-warden.config.js"),
    'module.exports = [{ dir: "packages/api", runner: "mocha" }];',
  );
  const ctx = JSON.parse(run(apiFile)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Invalid .*test-warden\.config\.js/);
  assert.match(ctx, /runner/);
});
