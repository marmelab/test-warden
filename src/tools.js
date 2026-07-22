// MCP tool surface: start/stop watches, force runs, read results, tail logs. Thin
// wrappers over the session engine — they translate tool calls into keystrokes on the
// pty and format the engine's return values as MCP text content.
import fs from "node:fs";
import { z } from "zod";
import { sleep } from "./core.js";
import { markTriggered, waitForResults } from "./results.js";
import {
  sessions,
  requireSession,
  stopSession,
  startWatchCore,
  ensureSession,
  awaitReady,
  isRunning,
} from "./session.js";

const CR = "\r";
const text = (s) => ({ content: [{ type: "text", text: s }] });

const notReadyText = (s) =>
  text(
    `The ${s.runner} watcher in ${s.cwd} is still starting up — not accepting commands yet. Check tail_log for what it's doing.`,
  );

const resultsText = (res) =>
  text(
    res
      ? JSON.stringify(res, null, 2)
      : JSON.stringify({ pending: true }, null, 2) +
          "\n// Still running after 30s — retry, or check tail_log.",
  );

// Shared selector: which watch session a command targets. Optional — omit when
// only one is running.
const cwdArg = {
  cwd: z
    .string()
    .optional()
    .describe("Which session (its start_watch cwd). Omit if only one is active."),
};

// run_* also auto-start a watch when none is running, so for them cwd doubles as the
// directory to start in.
const runCwdArg = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Project dir. Omit if a single watch is already running; pass it to target a specific watch, or to auto-start one if none is running.",
    ),
};

export function registerTools(server) {
  server.registerTool(
    "start_watch",
    {
      description:
        "Start (or restart, from cold) a jest/vitest watch in the given project. Rarely needed: every dir in test-warden.config.js is watched automatically from server startup, and calling this on a running watch restarts it. Once started, the watch runs continuously and automatically reruns every test impacted by any unstaged change. After 30 min without a run it stops itself; any run_* call restarts it transparently. The setup (runner, env, flags) comes from the project's test-warden.config.js — cwd must match one of its entries.",
      inputSchema: {
        cwd: z
          .string()
          .describe(
            "Absolute path to the project/workspace to run tests in. Must match a `dir` entry in test-warden.config.js.",
          ),
        args: z
          .string()
          .optional()
          .describe(
            "Extra CLI args appended to the runner, on top of the config entry's `args` (e.g. a path filter).",
          ),
        env: z
          .record(z.string())
          .optional()
          .describe(
            "Extra env vars for the runner, overriding the config entry's `env` per-call.",
          ),
      },
    },
    async ({ cwd, args, env }) => {
      const { session, error } = await startWatchCore({ cwd, args, env });
      if (error) return text(error);
      if (!(await awaitReady(session))) return notReadyText(session);
      return text(
        `Started ${session.runner} watch in ${session.cwd}. ${sessions.size} session(s) active. ` +
          `Editing code auto-reruns impacted tests; call get_results to read them, or ` +
          `run_all / run_failed / run_filtered to force a specific run.`,
      );
    },
  );

  server.registerTool(
    "run_all",
    {
      description:
        "Run the whole suite once and return its pass/fail results (counts + failing tests with messages). Waits for the run to finish. Auto-starts a watch if none is running yet (pass cwd).",
      inputSchema: runCwdArg,
    },
    async ({ cwd }) => {
      const { session: s, error } = await ensureSession(cwd);
      if (error) return text(error);
      if (!(await awaitReady(s))) return notReadyText(s);
      markTriggered(s);
      s.proc.write("a"); // "a" = run all, in the runner's watch UI
      s.fullScope = true; // "a" also durably escapes the startup --changed scope
      return resultsText(await waitForResults(s));
    },
  );

  server.registerTool(
    "run_failed",
    {
      description:
        "Rerun only the tests that failed in the last run and return the results — faster than the full suite while iterating on a fix. Waits for the run to finish. Auto-starts a watch if none is running (pass cwd).",
      inputSchema: runCwdArg,
    },
    async ({ cwd }) => {
      const { session: s, error } = await ensureSession(cwd);
      if (error) return text(error);
      if (!(await awaitReady(s))) return notReadyText(s);
      markTriggered(s);
      s.proc.write("f"); // "f" = run only failed, in the runner's watch UI
      return resultsText(await waitForResults(s));
    },
  );

  server.registerTool(
    "run_filtered",
    {
      description:
        "Run only the tests matching a pattern (by file path or test name) and return the results — use to focus on one area. Waits for the run to finish. Auto-starts a watch if none is running (pass cwd).",
      inputSchema: {
        pattern: z.string().describe("Regex/substring to filter by."),
        by: z
          .enum(["path", "name"])
          .default("path")
          .describe("Match the pattern against the test file path (default) or the test name."),
        ...runCwdArg,
      },
    },
    async ({ pattern, by, cwd }) => {
      const { session: s, error } = await ensureSession(cwd);
      if (error) return text(error);
      if (!(await awaitReady(s))) return notReadyText(s);
      // The watch starts scoped to changed files, and the interactive filter only
      // searches within that scope — so a filter for an untouched file finds nothing.
      // Escape once per session: run the full suite ("a") and let it land — filtering
      // mid-run cancels it before the scope widens — then filters see all files.
      // ponytail: costs one full-suite run on a session's first run_filtered; piloting
      // the watcher offers no cheaper reliable escape.
      if (!s.fullScope) {
        markTriggered(s);
        s.proc.write("a");
        await waitForResults(s);
        s.fullScope = true;
      }
      markTriggered(s);
      // Type the filter like a human: one keystroke per write, with a breath between.
      // A coalesced chunk ("todo\r") reaches jest's prompt as ONE key — the pattern
      // shows but the trailing Enter never registers, wedging the watcher in pattern
      // mode and eating every later keystroke.
      s.proc.write(by === "name" ? "t" : "p"); // "t" = filter by test name, "p" = by path
      for (const ch of pattern + CR) {
        await sleep(25);
        s.proc.write(ch);
      }
      return resultsText(await waitForResults(s));
    },
  );

  server.registerTool(
    "get_results",
    {
      description:
        "Read the latest run's results (pass/fail counts and failing tests with messages) without triggering a new run — use after editing code, since the watch auto-reruns impacted tests. Waits for an in-progress run to finish. Requires start_watch first (or use a run_* tool, which auto-starts).",
      inputSchema: cwdArg,
    },
    async ({ cwd }) => {
      const s = requireSession(cwd);
      // If the watcher is mid-run — typically an edit its own fs-watch just picked up —
      // snapshot now so waitForResults holds out for that run's fresh write instead of
      // returning the previous, pre-edit results (whose mtime already beats the last
      // trigger). Idle ⇒ no snapshot, so the latest results come straight back.
      if (isRunning(s)) markTriggered(s);
      return resultsText(await waitForResults(s));
    },
  );

  server.registerTool(
    "tail_log",
    {
      description:
        "Raw recent watcher output — for debugging the session, e.g. when get_results stays pending or the watcher seems stuck.",
      inputSchema: cwdArg,
    },
    async ({ cwd }) =>
      text(requireSession(cwd).log.join("").slice(-4000) || "(no output yet)"),
  );

  server.registerTool(
    "stop_watch",
    {
      description: "Stop the continuous watch for a project, or all watches when cwd is omitted.",
      inputSchema: cwdArg,
    },
    async ({ cwd }) => {
      // requireSession() realpaths cwd so a symlink/trailing-slash spelling still finds the session.
      const targets = cwd ? [requireSession(cwd)] : [...sessions.values()];
      if (!targets.length) return text("No session running.");
      await Promise.all(targets.map(stopSession)); // graceful — teardowns run
      for (const s of targets) {
        // onExit's cleanup normally handles both, but belt-and-braces for a watcher
        // that had to be hard-killed mid-boot.
        sessions.delete(s.cwd);
        fs.rmSync(s.liveFile, { force: true });
      }
      return text(`Stopped: ${targets.map((s) => s.cwd).join(", ")}.`);
    },
  );
}
