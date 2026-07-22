#!/usr/bin/env node
// Claude Code SessionStart hook (startup|resume): detect watchers that OTHER sessions
// still hold on this project and surface them to the agent, which should ask the user
// before anything is killed — the other session may be a live window the user still
// works in, so killing outright here would be destructive. Markers whose server is
// dead carry no such ambiguity and are reaped silently. Once the user confirms, the
// agent stops a watcher with `kill <pid>` (the server's SIGTERM handler kills its
// watchers, reaps markers, and exits) or via start_watch on the same cwd (takeover).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.TEST_WATCH_MCP_TMP || os.tmpdir();
let root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
try {
  root = fs.realpathSync(root);
} catch {
  /* keep as-is */
}

const found = [];
for (const name of fs.readdirSync(DIR)) {
  if (!/^test-warden-[0-9a-f]{8}\.live$/.test(name)) continue;
  const file = path.join(DIR, name);
  let pid, cwd;
  try {
    [pid, cwd] = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    continue; // reaped meanwhile
  }
  if (!cwd || (cwd !== root && !cwd.startsWith(root + path.sep))) continue; // other project
  try {
    process.kill(Number(pid), 0); // liveness probe only — never a kill
    found.push({ pid: Number(pid), cwd });
  } catch {
    fs.rmSync(file, { force: true }); // owner dead — plain garbage, reap silently
  }
}

// SessionStart stdout is injected into the session's context.
if (found.length)
  console.log(
    `test-warden: another session is still watching this project's tests: ${found
      .map((f) => `${f.cwd} (server pid ${f.pid})`)
      .join(", ")}. Ask the user whether to stop it. If they keep it, warn them: that ` +
      `watcher auto-reruns tests on every file edit, so test runs from this session ` +
      `can collide with it on shared resources (e.g. a test database on a fixed ` +
      `port). If they agree to stop it: \`kill <pid>\` shuts that server down ` +
      `cleanly (its watchers die with it), or call start_watch for that cwd to take ` +
      `the watch over into this session.`,
  );
process.exit(0);
