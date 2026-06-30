#!/usr/bin/env node
// test-warden — pilot jest/vitest watch processes over a PTY from an MCP client.
// One warm watch session per project dir (so a monorepo can watch several at once);
// the pty handles live in memory, so commands (run all / filter / failed) are just
// keystrokes written to the pty.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  buildCommand,
  detectRunner,
  resolveBin,
  scriptEnv,
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

// --- watch sessions, keyed by project dir ----------------------------------
const sessions = new Map(); // cwd -> { proc, runner, cwd, resultsFile, log, triggeredMtime }

const CR = "\r";
const text = (s) => ({ content: [{ type: "text", text: s }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve which session a command targets: explicit cwd, else the only one.
function pick(cwd) {
  if (cwd) {
    const s = sessions.get(cwd);
    if (s) return s;
    throw new Error(
      `No watch session for ${cwd}. Active: ${[...sessions.keys()].join(", ") || "none"}.`,
    );
  }
  if (sessions.size === 1) return [...sessions.values()][0];
  if (sessions.size === 0)
    throw new Error("No watch session. Call start_watch first.");
  throw new Error(
    `Multiple watch sessions active — pass cwd. Active: ${[...sessions.keys()].join(", ")}.`,
  );
}

// mtime of the results file, or 0 if it doesn't exist yet. Both jest's reporter
// and vitest's --outputFile rewrite the file on each run, so a rising mtime is
// the "a new run finished" edge.
// ponytail: relies on sub-second mtime (ext4/xfs/apfs have it); on a 1s-granularity
// FS a rerun finishing within the same second as the trigger reads as stale. Move
// to a run counter written by the reporter if that ever bites.
function resultsMtime(s) {
  try {
    return fs.statSync(s.resultsFile).mtimeMs;
  } catch {
    return 0;
  }
}

// Record the file's mtime at the instant a run is triggered, so get_results can
// tell the freshly-finished run apart from the previous run's leftover JSON.
function markTriggered(s) {
  s.triggeredMtime = resultsMtime(s);
}

function startSession({ runner, bin, cwd, args, env }) {
  // Per-cwd results file so concurrent watchers don't clobber each other's JSON.
  const slug = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  const resultsFile = path.join(
    os.tmpdir(),
    `test-warden-${process.pid}-${slug}.json`,
  );
  // Liveness marker for the nudge hook: present + pid-alive ⇒ this cwd is watched.
  // Unlike resultsFile (deleted here, reappears only after the first run), it exists
  // for the whole session, so the hook never false-nudges a freshly-started watch.
  const liveFile = path.join(os.tmpdir(), `test-warden-${slug}.live`);
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
    // Layer env: base process → what the project's test script sets (e.g. TZ=UTC)
    // → caller override → our required vars (which must win, esp. CI="" for watch).
    env: {
      ...process.env,
      ...scriptEnv(cwd),
      ...env,
      TEST_WATCH_MCP_OUT: resultsFile,
      CI: "",
    },
  });
  const log = [];
  proc.onData((d) => {
    log.push(d);
    if (log.length > 400) log.splice(0, log.length - 400);
  });
  fs.writeFileSync(liveFile, String(process.pid));
  const s = { proc, runner, cwd, resultsFile, liveFile, log, triggeredMtime: 0 };
  proc.onExit(() => {
    // Guarded: a restart (kill old → start new) writes the new marker before the
    // old proc's exit fires, so only the still-current session clears it.
    if (sessions.get(cwd) === s) {
      sessions.delete(cwd);
      fs.rmSync(liveFile, { force: true });
    }
  });
  // File was just deleted (mtime 0), so the watcher's initial run counts as fresh.
  sessions.set(cwd, s);
}

// Read whichever reporter wrote results and normalize to a compact summary.
function readResults(s) {
  let raw;
  try {
    raw = fs.readFileSync(s.resultsFile, "utf8");
  } catch {
    return null; // no run has completed yet
  }
  try {
    return normalizeResults(JSON.parse(raw));
  } catch {
    return null; // mid-write
  }
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
      env: z
        .record(z.string())
        .optional()
        .describe(
          "Extra env vars for the runner. Inline assignments in the project's `test` script (e.g. TZ=UTC) are applied automatically; use this for file-loaded vars (dotenv) or overrides.",
        ),
    },
  },
  async ({ runner, cwd, args, env }) => {
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
    const existing = sessions.get(cwd); // restart only this cwd's watcher
    if (existing) existing.proc.kill();
    startSession({ runner: resolved, bin, cwd, args, env });
    return text(
      `Started ${resolved} watch in ${cwd}. ${sessions.size} session(s) active. ` +
        `Use get_results (pass cwd when more than one) to read each run.`,
    );
  },
);

// Shared selector: which watch session a command targets. Optional — omit when
// only one is running.
const cwdArg = {
  cwd: z
    .string()
    .optional()
    .describe("Which session (its start_watch cwd). Omit if only one is active."),
};

server.registerTool(
  "run_all",
  {
    description: 'Rerun the entire suite (presses "a" in the watcher).',
    inputSchema: cwdArg,
  },
  async ({ cwd }) => {
    const s = pick(cwd);
    markTriggered(s);
    s.proc.write("a");
    return text(`Triggered: run all in ${s.cwd}.`);
  },
);

server.registerTool(
  "run_failed",
  {
    description: 'Rerun only previously failed tests (presses "f").',
    inputSchema: cwdArg,
  },
  async ({ cwd }) => {
    const s = pick(cwd);
    markTriggered(s);
    s.proc.write("f");
    return text(`Triggered: run failed in ${s.cwd}.`);
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
      ...cwdArg,
    },
  },
  async ({ pattern, by, cwd }) => {
    const s = pick(cwd);
    markTriggered(s);
    s.proc.write(by === "name" ? "t" : "p");
    s.proc.write(pattern + CR);
    return text(`Triggered: filter by ${by} /${pattern}/ in ${s.cwd}.`);
  },
);

server.registerTool(
  "get_results",
  {
    description:
      "Read the latest completed run: pass/fail counts and failing tests with messages.",
    inputSchema: cwdArg,
  },
  async ({ cwd }) => {
    const s = pick(cwd);
    // Block until the in-flight run lands instead of returning pending and making
    // the agent poll. Trust the JSON only once its mtime advanced past the trigger
    // (a fresh run) and it parses (not mid-write).
    // ponytail: 30s ceiling so we return before a typical MCP client request
    // timeout; bump it or make it an arg if a suite legitimately runs longer.
    const deadline = Date.now() + 30_000;
    let res = null;
    while (Date.now() < deadline) {
      if (resultsMtime(s) > s.triggeredMtime && (res = readResults(s))) break;
      await sleep(100);
    }
    if (!res)
      return text(
        JSON.stringify({ pending: true }, null, 2) +
          "\n// Still running after 30s — retry, or check tail_log.",
      );
    return text(JSON.stringify(res, null, 2));
  },
);

server.registerTool(
  "tail_log",
  {
    description: "Raw recent watcher output, for debugging the session.",
    inputSchema: cwdArg,
  },
  async ({ cwd }) =>
    text(pick(cwd).log.join("").slice(-4000) || "(no output yet)"),
);

server.registerTool(
  "stop_watch",
  {
    description: "Stop a watch process, or all of them when cwd is omitted.",
    inputSchema: cwdArg,
  },
  async ({ cwd }) => {
    const targets = cwd
      ? [sessions.get(cwd)].filter(Boolean)
      : [...sessions.values()];
    if (!targets.length)
      return text(cwd ? `No session for ${cwd}.` : "No session running.");
    for (const s of targets) {
      s.proc.kill();
      sessions.delete(s.cwd);
    }
    return text(`Stopped: ${targets.map((s) => s.cwd).join(", ")}.`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
