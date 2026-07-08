import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, bootstrap } from "../src/init.js";
import { loadConfig } from "../src/core.js";

const read = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));

test("init merges, preserves existing keys, and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twm-init-"));
  // Pre-existing config the user already had.
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".mcp.json"), '{"mcpServers":{"other":{}}}');
  fs.writeFileSync(
    path.join(dir, ".claude/settings.json"),
    '{"hooks":{"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo hi"}]}]}}',
  );

  run(dir);

  const mcp = read(dir, ".mcp.json");
  assert.ok(mcp.mcpServers.other, "kept existing mcp server");
  assert.equal(mcp.mcpServers["test-warden"].command, "npx");

  const hooks = read(dir, ".claude/settings.json").hooks;
  assert.equal(hooks.PostToolUse.length, 3, "kept existing hook, added notify + nudge");
  assert.ok(
    hooks.PostToolUse.some((g) => g.matcher === "Edit|Write"),
    "added the Edit|Write nudge hook",
  );
  assert.equal(hooks.SessionStart.length, 1, "added the session reset hook");
  assert.equal(hooks.SessionStart[0].matcher, "startup|resume");

  // Hook files copied into the project, with the core.js import rewritten.
  const hookDir = path.join(dir, ".claude/hooks/test-warden");
  for (const f of [
    "notify-on-fail.mjs",
    "nudge-watch.mjs",
    "reset-watch.mjs",
    "emit.mjs",
    "core.js",
  ]) {
    assert.ok(fs.existsSync(path.join(hookDir, f)), `copied ${f}`);
  }
  const nudge = fs.readFileSync(path.join(hookDir, "nudge-watch.mjs"), "utf8");
  assert.ok(nudge.includes('"./core.js"'), "rewrote core.js import");
  assert.ok(!nudge.includes("../src/core.js"), "no package-relative import left");

  // Second run adds nothing.
  run(dir);
  const again = read(dir, ".claude/settings.json").hooks;
  assert.equal(again.PostToolUse.length, 3);
  assert.equal(again.SessionStart.length, 1);
});

test("init materializes detection as test-warden.config.js and never overwrites it", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "twm-init-")));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      type: "module",
      devDependencies: { vitest: "^1" },
      scripts: { test: "TZ=UTC vitest run" },
    }),
  );

  run(dir);

  const cfgFile = path.join(dir, "test-warden.config.js");
  const src = fs.readFileSync(cfgFile, "utf8");
  assert.match(src, /^export default \[/m, "matches the project's module type");
  // The generated file round-trips through the server's loader.
  const [entry] = await loadConfig(dir);
  assert.equal(entry.runner, "vitest");
  assert.equal(entry.dir, dir);
  assert.deepEqual(entry.env, { TZ: "UTC" }, "test-script env baked in at init");

  // Hand-edits survive a re-init.
  fs.writeFileSync(cfgFile, "export default [];\n");
  run(dir);
  assert.equal(fs.readFileSync(cfgFile, "utf8"), "export default [];\n");
});

test("bootstrap overwrites an existing config, with a warning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twm-init-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ type: "module", devDependencies: { vitest: "^1" } }),
  );
  const cfgFile = path.join(dir, "test-warden.config.js");
  fs.writeFileSync(cfgFile, "export default [];\n"); // pre-existing, hand-made

  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    bootstrap(dir);
  } finally {
    console.warn = orig;
  }

  assert.match(warnings.join("\n"), /overwriting/i, "warned about the overwrite");
  assert.match(fs.readFileSync(cfgFile, "utf8"), /"runner": "vitest"/, "regenerated");

  // Fresh dir: no warning when nothing is overwritten.
  fs.rmSync(cfgFile);
  console.warn = (m) => warnings.push("unexpected: " + m);
  try {
    bootstrap(dir);
  } finally {
    console.warn = orig;
  }
  assert.ok(!warnings.some((w) => w.startsWith("unexpected")), "silent on fresh write");
});

test("init config: ambiguous runner leaves runner empty for the user to fill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twm-init-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ devDependencies: { jest: "^29", vitest: "^1" } }),
  );
  run(dir);
  const src = fs.readFileSync(path.join(dir, "test-warden.config.js"), "utf8");
  assert.match(src, /^module\.exports = \[/m, "CJS project gets module.exports");
  assert.match(src, /"runner": ""/);
  assert.match(src, /both present/);
});
