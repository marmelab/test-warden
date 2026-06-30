#!/usr/bin/env node
// test-warden — pilot a jest/vitest watch process over a PTY from an MCP client.
// One warm watch session per server process; the pty handle lives in memory, so
// commands (run all / filter / failed) are just keystrokes written to the pty.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  buildCommand,
  detectRunner,
  resolveBin,
  normalizeResults,
} from "./core.js";

// `test-warden init` wires the server + hook into the current project, then exits.
if (process.argv[2] === "init") {
  const { run } = await import("./init.js");
  run();
  process.exit(0);
}

// Loaded only when actually running the server — `init` must not need the native addon.
const pty = (await import("node-pty")).default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JEST_REPORTER = path.join(HERE, "jest-reporter.cjs");

// --- single watch session state -------------------------------------------
let session = null; // { proc, runner, cwd, resultsFile, log: string[], triggeredMtime }

const CR = "\r";
const text = (s) => ({ content: [{ type: "text", text: s }] });

// mtime of the results file, or 0 if it doesn't exist yet. Both jest's reporter
// and vitest's --outputFile rewrite the file on each run, so a rising mtime is
// the "a new run finished" edge.
// ponytail: relies on sub-second mtime (ext4/xfs/apfs have it); on a 1s-granularity
// FS a rerun finishing within the same second as the trigger reads as stale. Move
// to a run counter written by the reporter if that ever bites.
function resultsMtime() {
  try {
    return fs.statSync(session.resultsFile).mtimeMs;
  } catch {
    return 0;
  }
}

// Record the file's mtime at the instant a run is triggered, so get_results can
// tell the freshly-finished run apart from the previous run's leftover JSON.
function markTriggered() {
  session.triggeredMtime = resultsMtime();
}

function startSession({ runner, bin, cwd, args }) {
  const resultsFile = path.join(os.tmpdir(), `test-warden-${process.pid}.json`);
  try {
    fs.rmSync(resultsFile, { force: true });
  } catch {
    /* ignore */
  }
  const cmd = buildCommand(runner, bin, resultsFile, JEST_REPORTER, args);
  const proc = pty.spawn("/bin/sh", ["-c", cmd], {
    name: "xterm-color",
    cols: 120,
    rows: 40,
    cwd,
    env: { ...process.env, TEST_WATCH_MCP_OUT: resultsFile, CI: "" },
  });
  const log = [];
  proc.onData((d) => {
    log.push(d);
    if (log.length > 400) log.splice(0, log.length - 400);
  });
  proc.onExit(() => {
    if (session && session.proc === proc) session = null;
  });
  // File was just deleted (mtime 0), so the watcher's initial run counts as fresh.
  session = { proc, runner, cwd, resultsFile, log, triggeredMtime: 0 };
}

// Read whichever reporter wrote results and normalize to a compact summary.
function readResults() {
  if (!session) return null;
  let raw;
  try {
    raw = fs.readFileSync(session.resultsFile, "utf8");
  } catch {
    return null; // no run has completed yet
  }
  try {
    return normalizeResults(JSON.parse(raw));
  } catch {
    return null; // mid-write
  }
}

function requireSession() {
  if (!session) throw new Error("No watch session. Call start_watch first.");
  return session;
}

// --- MCP server -------------------------------------------------------------
const server = new McpServer({ name: "test-warden", version: "0.1.0" });

server.registerTool(
  "start_watch",
  {
    description:
      "Start a warm jest/vitest watch process in the given project. Pays cold-start once; later run_* tools are instant keystrokes to the running process. The runner is auto-detected from cwd's package.json — only pass it to override.",
    inputSchema: {
      cwd: z
        .string()
        .describe("Absolute path to the project/workspace to run tests in."),
      runner: z
        .enum(["jest", "vitest"])
        .optional()
        .describe("Override auto-detection (e.g. when a package has both)."),
      args: z
        .string()
        .optional()
        .describe(
          "Extra CLI args appended to the runner (e.g. a path filter).",
        ),
    },
  },
  async ({ runner, cwd, args }) => {
    let resolved = runner;
    if (!resolved) {
      try {
        resolved = detectRunner(cwd);
      } catch (e) {
        return text(e.message); // both detected — ask the agent to specify
      }
      if (!resolved)
        return text(
          `No jest or vitest found in ${cwd}. This server only drives those two runners.`,
        );
    }
    const bin = resolveBin(cwd, resolved);
    if (!bin)
      return text(
        `${resolved} is not installed in ${cwd} (no node_modules/.bin/${resolved}). Install deps first.`,
      );
    if (session) session.proc.kill();
    startSession({ runner: resolved, bin, cwd, args });
    return text(
      `Started ${resolved} watch in ${cwd}. Use get_results to read each run.`,
    );
  },
);

server.registerTool(
  "run_all",
  {
    description: 'Rerun the entire suite (presses "a" in the watcher).',
    inputSchema: {},
  },
  async () => {
    const s = requireSession();
    markTriggered();
    s.proc.write("a");
    return text("Triggered: run all.");
  },
);

server.registerTool(
  "run_failed",
  {
    description: 'Rerun only previously failed tests (presses "f").',
    inputSchema: {},
  },
  async () => {
    const s = requireSession();
    markTriggered();
    s.proc.write("f");
    return text("Triggered: run failed.");
  },
);

server.registerTool(
  "run_filtered",
  {
    description:
      "Rerun tests matching a pattern, by file path or by test name.",
    inputSchema: {
      pattern: z.string().describe("Regex/substring to filter by."),
      by: z.enum(["path", "name"]).default("path"),
    },
  },
  async ({ pattern, by }) => {
    const s = requireSession();
    markTriggered();
    s.proc.write(by === "name" ? "t" : "p");
    s.proc.write(pattern + CR);
    return text(`Triggered: filter by ${by} /${pattern}/.`);
  },
);

server.registerTool(
  "get_results",
  {
    description:
      "Read the latest completed run: pass/fail counts and failing tests with messages.",
    inputSchema: {},
  },
  async () => {
    requireSession();
    // The previous run's JSON is still on disk; only trust it once the file's
    // mtime has advanced past the moment the current run was triggered.
    if (resultsMtime() <= session.triggeredMtime)
      return text(
        JSON.stringify({ pending: true }, null, 2) +
          "\n// Run still in progress — give it a moment, then retry.",
      );
    const res = readResults();
    if (!res)
      return text(
        JSON.stringify({ pending: true }, null, 2) + "\n// mid-write",
      );
    return text(JSON.stringify(res, null, 2));
  },
);

server.registerTool(
  "tail_log",
  {
    description: "Raw recent watcher output, for debugging the session.",
    inputSchema: {},
  },
  async () =>
    text(requireSession().log.join("").slice(-4000) || "(no output yet)"),
);

server.registerTool(
  "stop_watch",
  { description: "Stop the watch process.", inputSchema: {} },
  async () => {
    if (!session) return text("No session running.");
    session.proc.kill();
    session = null;
    return text("Stopped.");
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
