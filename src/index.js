#!/usr/bin/env node
// test-warden — pilot jest/vitest watch processes over a PTY from an MCP client.
// One warm watch session per project dir (so a monorepo can watch several at once).
// This file is the entrypoint only: CLI dispatch, config load, wiring the session
// engine (session.js) to the MCP tools (tools.js), process lifecycle, and boot.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core.js";
import {
  setConfig,
  sessions,
  sleep,
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
