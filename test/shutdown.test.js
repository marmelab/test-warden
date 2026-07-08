// Regression: a server whose client goes away must not outlive it. The pty children
// keep node's event loop alive, so before the stdin-"end" shutdown hook a finished
// session left a zombie server whose watcher kept rerunning tests on every edit and
// whose .live marker locked the project against the next session's server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugFor } from "../src/core.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = path.join(ROOT, "demo", "vitest");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Minimal MCP client over newline-delimited JSON-RPC on the server's stdio.
function rpc(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}
function nextResponse(proc, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`no response ${id} after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onData = (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = JSON.parse(line);
        if (m.id === id) {
          clearTimeout(timer);
          proc.stdout.off("data", onData);
          resolve(m);
        }
      }
    };
    proc.stdout.on("data", onData);
  });
}

const spawnServer = () =>
  spawn(process.execPath, [path.join(ROOT, "src", "index.js")], {
    stdio: ["pipe", "pipe", "inherit"],
  });

async function boot(server) {
  rpc(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  await nextResponse(server, 1, 10_000);
  rpc(server, { jsonrpc: "2.0", method: "notifications/initialized" });
}

async function startWatch(server) {
  rpc(server, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "start_watch", arguments: { cwd: DEMO } },
  });
  const res = await nextResponse(server, 2, 90_000); // vitest cold start
  return res.result.content[0].text;
}

const exitOf = (proc, ms) =>
  proc.exitCode !== null
    ? Promise.resolve(proc.exitCode)
    : Promise.race([
        new Promise((r) => proc.on("exit", r)),
        new Promise((r) => setTimeout(() => r("zombie"), ms)),
      ]);

const LIVE_FILE = path.join(os.tmpdir(), `test-warden-${slugFor(DEMO)}.live`);
const markerPid = () => Number(fs.readFileSync(LIVE_FILE, "utf8").split("\n")[0]);

test("closing stdin kills the server, its watcher, and the live marker", async () => {
  const server = spawnServer();
  try {
    await boot(server);
    assert.match(await startWatch(server), /Started vitest watch/);

    const liveFile = LIVE_FILE;
    assert.ok(fs.existsSync(liveFile), "live marker written");
    // The watcher is the server's `sh -c vitest ...` child.
    const watcherPid = Number(
      execSync(`ps -o pid= --ppid ${server.pid}`).toString().trim(),
    );
    assert.ok(alive(watcherPid), "watcher running");

    server.stdin.end(); // the client goes away
    assert.equal(await exitOf(server, 15_000), 0);
    assert.ok(!fs.existsSync(liveFile), "live marker reaped");
    // pty child gets killed on shutdown; give the signal a beat to land.
    for (let i = 0; i < 50 && alive(watcherPid); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(!alive(watcherPid), "watcher process gone");
  } finally {
    if (server.exitCode === null) server.kill("SIGKILL");
  }
});

test("start_watch takes the watch over from a forgotten live server (newest wins)", async () => {
  const a = spawnServer();
  const b = spawnServer();
  try {
    await boot(a);
    assert.match(await startWatch(a), /Started vitest watch/);
    assert.equal(markerPid(), a.pid, "first server owns the watch");

    // Second session starts while the first is still alive and holding the watch.
    await boot(b);
    assert.match(await startWatch(b), /Started vitest watch/);
    assert.equal(markerPid(), b.pid, "second server took the watch over");
    assert.equal(await exitOf(a, 15_000), 0, "evicted server exited cleanly");
  } finally {
    for (const p of [a, b]) if (p.exitCode === null) p.kill("SIGKILL");
    fs.rmSync(LIVE_FILE, { force: true });
  }
});
