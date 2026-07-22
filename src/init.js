// `test-warden init` — wire this MCP server + failure hook into a project.
// Merges into existing config (never clobbers other keys); idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectRunner, scriptEnv } from "./core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(HERE, "..", "hooks");
// Hook files are copied into the project so the commands are stable and
// committable (an npx-cache path breaks on `npm cache clean` and on other machines).
const DEST = ".claude/hooks/test-warden";
const COPIES = [
  [path.join(HOOKS, "notify-on-fail.mjs"), "notify-on-fail.mjs"],
  [path.join(HOOKS, "block-on-fail.mjs"), "block-on-fail.mjs"],
  [path.join(HOOKS, "nudge-watch.mjs"), "nudge-watch.mjs"],
  [path.join(HOOKS, "reset-watch.mjs"), "reset-watch.mjs"],
  [path.join(HOOKS, "emit.mjs"), "emit.mjs"],
  [path.join(HERE, "core.js"), "core.js"],
];
// notify: surface failing runs (any tool). nudge: offer to start a watch on edit.
// reset: on session start/resume, evict watchers left by previous sessions.
// block: at end of turn, don't let the agent finish on a red suite (Stop has no matcher).
const HOOKS_BY_EVENT = {
  PostToolUse: [
    { matcher: "*", command: `node "$CLAUDE_PROJECT_DIR/${DEST}/notify-on-fail.mjs"` },
    { matcher: "Edit|Write", command: `node "$CLAUDE_PROJECT_DIR/${DEST}/nudge-watch.mjs"` },
  ],
  SessionStart: [
    { matcher: "startup|resume", command: `node "$CLAUDE_PROJECT_DIR/${DEST}/reset-watch.mjs"` },
  ],
  Stop: [{ command: `node "$CLAUDE_PROJECT_DIR/${DEST}/block-on-fail.mjs"` }],
};

// Materialize the detected test setup as test-warden.config.js source. Detection
// runs ONLY here, at bootstrap time; the server refuses to start without a valid
// config, so anything detection gets wrong (custom bin, dotenv files, monorepo
// packages) must be hand-edited in.
export function configSource(cwd) {
  let entry, note;
  try {
    const runner = detectRunner(cwd);
    if (runner) entry = { dir: ".", runner, args: "", env: scriptEnv(cwd) };
    else note = '// No jest/vitest detected. The server refuses an empty config — add entries, e.g.:\n  // { dir: ".", runner: "vitest", args: "", env: {} },';
  } catch {
    entry = { dir: ".", runner: "", args: "", env: scriptEnv(cwd) };
    note = '// jest AND vitest are both present — set `runner` ("jest" or "vitest"); the server refuses to start until it is valid.';
  }
  // Match the project's module system: a `.js` file parses as ESM only under
  // `"type": "module"`, so a CJS project needs module.exports.
  let esm = false;
  try {
    esm = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).type === "module";
  } catch {
    /* no package.json — CJS default */
  }
  return (
    "// test-warden.config.js — REQUIRED: how test-warden runs this project's tests.\n" +
    "// The server reads and validates this on startup and refuses to start if it is\n" +
    "// missing or invalid. Edit freely — `init` never overwrites it; regenerate from\n" +
    "// scratch with `npx test-warden bootstrap` (overwrites, warns).\n" +
    "//\n" +
    "// One entry per package/workspace whose tests can be run. Keys:\n" +
    "//   dir:    directory to run tests in, relative to this file (default \".\").\n" +
    "//           Monorepo: add one entry per package, e.g. \"packages/api\".\n" +
    '//   runner: "jest" | "vitest" (required — the only supported runners).\n' +
    "//   args:   extra CLI flags appended to every run, e.g. \"--config jest.custom.js\"\n" +
    "//           (default \"\").\n" +
    "//   env:    env vars (string values) set for the runner, e.g. { \"TZ\": \"UTC\" }.\n" +
    "//           Inline vars from the package's `test` script are pre-filled; add\n" +
    "//           anything a .env file or CI would normally provide (default {}).\n" +
    "//   bin:    optional path to the runner binary, relative to this file, e.g.\n" +
    "//           \"tools/vitest-wrapper\". Default: nearest node_modules/.bin/<runner>\n" +
    "//           walking up from `dir` (hoisted monorepo installs resolve).\n" +
    "// No other keys are allowed (validation rejects typos).\n" +
    (esm ? "export default [\n" : "module.exports = [\n") +
    (note ? `  ${note}\n` : "") +
    (entry ? `  ${JSON.stringify(entry, null, 2).replace(/\n/g, "\n  ")},\n` : "") +
    "];\n"
  );
}

// Read JSON (or {} if absent/empty), apply `merge`, write back pretty-printed.
function patchJson(file, merge) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* new or empty file */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merge(cur), null, 2) + "\n");
}

export function run(cwd = process.cwd()) {
  // 0) Copy hook files into the project. Overwrite each run — re-running init
  // after an upgrade refreshes them. core.js moves next to the hooks, so its
  // import path is rewritten.
  const destDir = path.join(cwd, DEST);
  fs.mkdirSync(destDir, { recursive: true });
  for (const [src, name] of COPIES) {
    const code = fs.readFileSync(src, "utf8").replace("../src/core.js", "./core.js");
    fs.writeFileSync(path.join(destDir, name), code);
  }

  // 1) Register the MCP server (project-scoped; read by any MCP client).
  patchJson(path.join(cwd, ".mcp.json"), (c) => ({
    ...c,
    mcpServers: {
      ...c.mcpServers,
      "test-warden": { command: "npx", args: ["-y", "test-warden"] },
    },
  }));

  // 2) Add the hooks (Claude Code), per event, skipping any already present.
  patchJson(path.join(cwd, ".claude", "settings.json"), (c) => {
    const hooks = { ...c.hooks };
    for (const [event, wanted] of Object.entries(HOOKS_BY_EVENT)) {
      const cur = hooks[event] ?? [];
      const has = (cmd) => cur.some((g) => g.hooks?.some((h) => h.command === cmd));
      const additions = wanted.filter((h) => !has(h.command)).map((h) => ({
        matcher: h.matcher,
        hooks: [{ type: "command", command: h.command }],
      }));
      if (additions.length) hooks[event] = [...cur, ...additions];
    }
    return { ...c, hooks };
  });

  // 3) Bootstrap test-warden.config.js — the server refuses to start without it.
  // init never overwrites: once generated it's the user's file (the whole point is
  // hand-tuning setups detection gets wrong). `test-warden bootstrap` regenerates.
  if (!fs.existsSync(path.join(cwd, "test-warden.config.js"))) bootstrap(cwd);

  console.log(
    `test-warden: registered MCP server in .mcp.json, copied hooks to ${DEST}/, wired them in .claude/settings.json (${cwd})`,
  );
}

// `test-warden bootstrap` — (re)generate test-warden.config.js from detection.
// Unlike init, this OVERWRITES an existing config, so warn loudly when it does.
export function bootstrap(cwd = process.cwd()) {
  const file = path.join(cwd, "test-warden.config.js");
  if (fs.existsSync(file))
    console.warn(
      "test-warden: WARNING — overwriting existing test-warden.config.js; manual edits are lost (recover them from git if committed).",
    );
  fs.writeFileSync(file, configSource(cwd));
  console.log(`test-warden: wrote ${file} — review and edit it to match your setup.`);
}
