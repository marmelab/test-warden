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

test("closing stdin kills the server, its watcher, and the live marker", async () => {
  const server = spawn(process.execPath, [path.join(ROOT, "src", "index.js")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
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
    rpc(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "start_watch", arguments: { cwd: DEMO } },
    });
    const res = await nextResponse(server, 2, 90_000); // vitest cold start
    assert.match(res.result.content[0].text, /Started vitest watch/);

    const liveFile = path.join(os.tmpdir(), `test-warden-${slugFor(DEMO)}.live`);
    assert.ok(fs.existsSync(liveFile), "live marker written");
    // The watcher is the server's `sh -c vitest ...` child.
    const watcherPid = Number(
      execSync(`ps -o pid= --ppid ${server.pid}`).toString().trim(),
    );
    assert.ok(alive(watcherPid), "watcher running");

    server.stdin.end(); // the client goes away
    const code = await Promise.race([
      new Promise((r) => server.on("exit", r)),
      new Promise((r) => setTimeout(() => r("zombie"), 15_000)),
    ]);
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(liveFile), "live marker reaped");
    // pty child gets killed on shutdown; give the signal a beat to land.
    for (let i = 0; i < 50 && alive(watcherPid); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(!alive(watcherPid), "watcher process gone");
  } finally {
    if (server.exitCode === null) server.kill("SIGKILL");
  }
});
