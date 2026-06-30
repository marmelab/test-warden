import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/init.js";

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

  const post = read(dir, ".claude/settings.json").hooks.PostToolUse;
  assert.equal(post.length, 3, "kept existing hook, added notify + nudge");
  assert.ok(
    post.some((g) => g.matcher === "Edit|Write"),
    "added the Edit|Write nudge hook",
  );

  // Second run adds nothing.
  run(dir);
  assert.equal(read(dir, ".claude/settings.json").hooks.PostToolUse.length, 3);
});
