#!/usr/bin/env node
// test-warden — pilot jest/vitest watch processes over a PTY from an MCP client.
// One warm watch session per project dir (so a monorepo can watch several at once).
// This file is the entrypoint only: CLI dispatch, config load, wiring the session
// engine (session.js) to the MCP tools (tools.js), process lifecycle, and boot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, listInstances, slugFor, sleep } from "./core.js";
import {
  setConfig,
  startIdleSweep,
  sessions,
  stopSession,
  startWatchCore,
  watchedElsewhere,
  QUIT_GRACE_MS,
} from "./session.js";
import { registerTools } from "./tools.js";

// `test-warden init` wires the server + hooks into the current project;
// `test-warden bootstrap` (re)generates test-warden.config.js (overwrites, warns).
// Handled before config load — init runs where no config exists yet.
if (process.argv[2] === "init" || process.argv[2] === "bootstrap") {
  const mod = await import("./init.js");
  (process.argv[2] === "init" ? mod.run : mod.bootstrap)();
  process.exit(0);
}

// Instance-management subcommands — inspect/control the live servers behind the .live
// markers (see shutdown() below for the zombie/collision cases they're for), out of
// band from any MCP client. They read the markers directly and need no config, so
// they run before loadConfig. `logs -f` never returns (it follows), so nothing here
// falls through to the server boot.
const tmp = os.tmpdir();
const logPath = (slug) => path.join(tmp, `test-warden-${slug}.log`);

function cmdLs() {
  const rows = listInstances();
  if (!rows.length) return console.log("No test-warden running.");
  console.log("PID\tDIR\tSLUG\tRESULTS");
  for (const { pid, cwd, slug } of rows) {
    let age = "—";
    try {
      const mtime = fs.statSync(path.join(tmp, `test-warden-${slug}.json`)).mtimeMs;
      age = `${Math.round((Date.now() - mtime) / 1000)}s ago`;
    } catch {
      /* no results file yet — first run hasn't completed */
    }
    console.log(`${pid}\t${cwd}\t${slug}\t${age}`);
  }
}

function cmdKill(args) {
  const all = args.includes("--all");
  const dir = args.find((a) => !a.startsWith("-"));
  if (!all && !dir) {
    console.error("usage: test-warden kill <dir> | --all");
    process.exit(1);
  }
  const rows = listInstances();
  const targets = all ? rows : rows.filter((r) => r.slug === slugFor(dir));
  if (!targets.length)
    return console.log(all ? "No test-warden running." : `No test-warden watching ${dir}.`);
  // One server can hold several markers (a monorepo watching several dirs), so SIGTERM
  // each pid once. Its own shutdown() then quits every watcher gracefully and reaps the
  // markers — no SIGKILL escalation.
  for (const pid of new Set(targets.map((r) => r.pid))) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to ${pid}.`);
    } catch {
      console.log(`pid ${pid} already gone.`);
    }
  }
}

async function cmdLogs(args) {
  const follow = args.includes("-f") || args.includes("--follow");
  const dir = args.find((a) => !a.startsWith("-"));
  if (!dir) {
    console.error("usage: test-warden logs <dir> [-f]");
    process.exit(1);
  }
  const file = logPath(slugFor(dir));
  let content;
  try {
    content = fs.readFileSync(file); // raw bytes — .length is the byte offset to follow from
  } catch {
    return console.log("(no log; not watched, or watcher just started)");
  }
  process.stdout.write(content);
  if (!follow) return;
  // Follow: stream appended bytes; re-read from the top on truncate (a new session
  // starts the log fresh). fs.watch keeps the event loop alive until Ctrl-C.
  let offset = content.length;
  fs.watch(file, () => {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // reaped mid-follow — the session ended
    }
    if (size < offset) offset = 0; // truncated ⇒ new session
    if (size <= offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    process.stdout.write(buf);
    offset = size;
  });
  await new Promise(() => {}); // never resolves — stay alive following
}

const MANAGE = { ls: cmdLs, kill: cmdKill, logs: cmdLogs };
if (MANAGE[process.argv[2]]) {
  await MANAGE[process.argv[2]](process.argv.slice(3));
  process.exit(0);
}

// Materialized test setup, written by `test-warden init` in the project root (which
// is where MCP clients spawn this server) and validated here. It is the ONLY source
// of truth — no live detection — so a missing or invalid config is fatal: better a
// clear startup failure (the message lands in the client's MCP logs) than tools that
// guess wrong about how to run the project's tests.
let CONFIG;
try {
  CONFIG = await loadConfig(process.cwd());
} catch (e) {
  console.error(`test-warden: ${e.message}`);
  process.exit(1);
}
setConfig(CONFIG);
startIdleSweep(); // side-effecting timer starts here, not at module import

// --- MCP server -------------------------------------------------------------
const server = new McpServer({ name: "test-warden", version: "0.1.0" });
registerTools(server);

// Die with the client. The pty children keep the event loop alive, so without this a
// finished session leaves a zombie server whose watchers keep rerunning tests on every
// edit (colliding with the next session's runs — e.g. on a shared test database) and
// whose .live markers lock the projects against the next session's server.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; // SIGTERM + stdin-end can both fire; quit once
  shuttingDown = true;
  // Graceful quit so suite teardowns run (test DBs release their ports); the outer
  // race caps the wait so an unkillable child can't keep a zombie server alive.
  await Promise.race([
    Promise.all([...sessions.values()].map(stopSession)),
    sleep(QUIT_GRACE_MS + 2_000),
  ]);
  for (const s of sessions.values()) {
    s.proc.kill();
    fs.rmSync(s.liveFile, { force: true });
    fs.rmSync(s.resultsFile, { force: true });
    fs.rmSync(s.logFile, { force: true });
  }
  process.exit(0);
}
process.stdin.on("end", shutdown); // client closed the pipe — the session is over
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Auto-start every configured watch at boot: no start_watch call is needed, and the
// runner's own fs watching catches ANY change — editor, sed, git checkout — not just
// tool-call edits. Awaited BEFORE the transport connects so a tool call can't race a
// boot start on the same cwd (startWatchCore isn't reentrant per cwd); it returns at
// pty-spawn, not suite-ready, so this stays sub-second. On failure (deps missing,
// node-pty unbuilt) the error lands in the MCP logs and start_watch still works.
// Boot does NOT evict another server's watch: two sessions opening the same repo
// shouldn't SIGTERM each other on startup.
for (const e of CONFIG) {
  if (watchedElsewhere(e.dir)) continue;
  const { error } = await startWatchCore({ cwd: e.dir });
  if (error) console.error(`test-warden: auto-start ${e.dir}: ${error}`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
