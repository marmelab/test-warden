import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listInstances, slugFor } from "../src/core.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "src", "index.js");
const VITEST = path.join(ROOT, "demo", "vitest", "node_modules", ".bin", "vitest");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (args) => execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

// A .live marker as spawnWatcher writes it: "<pid>\n<cwd>".
const marker = (dir, slug, pid, cwd) =>
  fs.writeFileSync(path.join(dir, `test-warden-${slug}.live`), `${pid}\n${cwd}`);

test("listInstances: lists live markers, reaps dead ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ls-"));
  const cwd = "/some/project";
  const liveSlug = slugFor(cwd);
  marker(dir, liveSlug, process.pid, cwd); // our own pid — alive
  // A dead pid: 2^31-1 is not a real process, so process.kill(pid, 0) throws.
  const deadCwd = "/gone/project";
  const deadSlug = slugFor(deadCwd);
  marker(dir, deadSlug, 2147483647, deadCwd);
  // Noise that must be ignored.
  fs.writeFileSync(path.join(dir, "test-warden-abc.json"), "{}");
  fs.writeFileSync(path.join(dir, "unrelated.live"), "x");

  const rows = listInstances(dir);

  assert.equal(rows.length, 1, "only the live marker is listed");
  assert.deepEqual(rows[0], { pid: process.pid, slug: liveSlug, cwd });
  assert.equal(
    fs.existsSync(path.join(dir, `test-warden-${deadSlug}.live`)),
    false,
    "the dead marker was reaped",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// End-to-end: a real auto-started server persists its watcher log to disk, and the
// ls / logs / kill subcommands drive it out of band through the .live markers. A
// fresh temp project ⇒ its own slug, so this can't collide with other test files'
// DEMO servers running concurrently.
test("ls / logs / kill drive a live server via its markers", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tw-manage-"));
  fs.writeFileSync(path.join(proj, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(proj, "sum.test.js"),
    'import { test, expect } from "vitest";\ntest("ok", () => expect(1).toBe(1));\n',
  );
  fs.writeFileSync(
    path.join(proj, "test-warden.config.js"),
    `export default [{ dir: ".", runner: "vitest", bin: ${JSON.stringify(VITEST)} }];`,
  );

  const server = spawn(process.execPath, [BIN], {
    cwd: proj,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const real = fs.realpathSync(proj); // marker cwd is realpath'd by the server
  const slug = slugFor(proj);
  const logFile = path.join(os.tmpdir(), `test-warden-${slug}.log`);
  const liveFile = path.join(os.tmpdir(), `test-warden-${slug}.live`);
  const logHas = (re) => {
    try {
      return re.test(fs.readFileSync(logFile, "utf8"));
    } catch {
      return false;
    }
  };
  try {
    // Auto-start persists the log at boot; wait until the watcher reaches idle so its
    // output has settled (no concurrent append racing the reads below).
    for (let i = 0; i < 450 && !logHas(/Waiting for file changes/); i++) await sleep(200);
    assert.ok(logHas(/Waiting for file changes/), "watcher output persisted to the log file");

    const ls = cli(["ls"]);
    assert.match(ls, new RegExp(`(^|\\s)${server.pid}\\s`), "ls shows the server pid");
    assert.ok(ls.includes(real), "ls shows the project dir");

    const logs = cli(["logs", proj]);
    assert.equal(logs, fs.readFileSync(logFile, "utf8"), "logs prints the persisted log");

    const killed = cli(["kill", proj]);
    assert.match(killed, new RegExp(`SIGTERM to ${server.pid}`));
    const code = await Promise.race([
      new Promise((r) => server.on("exit", () => r(server.exitCode))),
      sleep(20_000).then(() => "zombie"),
    ]);
    assert.equal(code, 0, "server exited on SIGTERM");
    assert.ok(!fs.existsSync(logFile), "log file reaped on shutdown");
  } finally {
    if (server.exitCode === null) server.kill("SIGKILL");
    fs.rmSync(liveFile, { force: true });
    fs.rmSync(logFile, { force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
