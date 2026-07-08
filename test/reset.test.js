import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugFor } from "../src/core.js";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "reset-watch.mjs",
);

// Run the hook with an isolated marker dir, as if a session started in `project`.
const run = (tmp, project) =>
  execFileSync("node", [HOOK], {
    env: { ...process.env, TEST_WATCH_MCP_TMP: tmp, CLAUDE_PROJECT_DIR: project },
    encoding: "utf8",
  });

const marker = (tmp, cwd) => path.join(tmp, `test-warden-${slugFor(cwd)}.live`);

test("reports another session's live watcher and asks — never kills it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-proj-"));
  const pkg = path.join(project, "packages", "api");
  fs.mkdirSync(pkg, { recursive: true });
  // Stand-in for the other session's server: a live process that must survive.
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    fs.writeFileSync(marker(tmp, pkg), `${owner.pid}\n${pkg}`); // package under the project

    const out = run(tmp, project);
    assert.match(out, /still watching/);
    assert.match(out, /Ask the user/);
    assert.match(out, new RegExp(`server pid ${owner.pid}`));
    assert.match(out, /collide/, "explains the keep-it caveat");
    assert.equal(owner.exitCode, null, "live watcher untouched");
    assert.ok(fs.existsSync(marker(tmp, pkg)), "marker untouched");
  } finally {
    owner.kill("SIGKILL");
  }
});

test("silently reaps a dead server's marker — nothing to ask about", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-proj-"));
  const m = marker(tmp, project);
  fs.writeFileSync(m, `2147483646\n${project}`); // pid almost certainly not running

  assert.equal(run(tmp, project).trim(), "", "silent");
  assert.equal(fs.existsSync(m), false, "stale marker reaped");
});

test("leaves other projects' watchers alone", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-proj-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-other-"));
  const m = marker(tmp, other);
  fs.writeFileSync(m, `${process.pid}\n${other}`); // live pid, different project

  assert.equal(run(tmp, project).trim(), "", "silent — not this project's watcher");
  assert.ok(fs.existsSync(m), "other project's marker untouched");
});

test("old-format marker (pid only) is matched to the project root by slug", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "twm-reset-proj-"));
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    fs.writeFileSync(marker(tmp, project), String(owner.pid)); // pre-upgrade format

    const out = run(tmp, project);
    assert.match(out, /Ask the user/);
    assert.equal(owner.exitCode, null, "live watcher untouched");
  } finally {
    owner.kill("SIGKILL");
  }
});
