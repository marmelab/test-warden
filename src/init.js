// `test-warden init` — wire this MCP server + failure hook into a project.
// Merges into existing config (never clobbers other keys); idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(HERE, "..", "hooks");
// Hook files are copied into the project so the commands are stable and
// committable (an npx-cache path breaks on `npm cache clean` and on other machines).
const DEST = ".claude/hooks/test-warden";
const COPIES = [
  [path.join(HOOKS, "notify-on-fail.mjs"), "notify-on-fail.mjs"],
  [path.join(HOOKS, "nudge-watch.mjs"), "nudge-watch.mjs"],
  [path.join(HOOKS, "emit.mjs"), "emit.mjs"],
  [path.join(HERE, "core.js"), "core.js"],
];
// notify: surface failing runs (any tool). nudge: offer to start a watch on edit.
const POST_HOOKS = [
  { matcher: "*", command: `node "$CLAUDE_PROJECT_DIR/${DEST}/notify-on-fail.mjs"` },
  { matcher: "Edit|Write", command: `node "$CLAUDE_PROJECT_DIR/${DEST}/nudge-watch.mjs"` },
];

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

  // 2) Add the PostToolUse hooks (Claude Code), skipping any already present.
  patchJson(path.join(cwd, ".claude", "settings.json"), (c) => {
    const post = c.hooks?.PostToolUse ?? [];
    const has = (cmd) => post.some((g) => g.hooks?.some((h) => h.command === cmd));
    const additions = POST_HOOKS.filter((h) => !has(h.command)).map((h) => ({
      matcher: h.matcher,
      hooks: [{ type: "command", command: h.command }],
    }));
    if (!additions.length) return c;
    return {
      ...c,
      hooks: { ...c.hooks, PostToolUse: [...post, ...additions] },
    };
  });

  console.log(
    `test-warden: registered MCP server in .mcp.json, copied hooks to ${DEST}/, wired them in .claude/settings.json (${cwd})`,
  );
}
