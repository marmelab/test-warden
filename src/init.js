// `test-warden init` — wire this MCP server + failure hook into a project.
// Merges into existing config (never clobbers other keys); idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(HERE, "..", "hooks");
// Absolute paths so the hook commands work regardless of cwd.
// notify: surface failing runs (any tool). nudge: offer to start a watch on edit.
const POST_HOOKS = [
  { matcher: "*", command: `node ${path.join(HOOKS, "notify-on-fail.mjs")}` },
  { matcher: "Edit|Write", command: `node ${path.join(HOOKS, "nudge-watch.mjs")}` },
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
    `test-warden: registered MCP server in .mcp.json and hooks in .claude/settings.json (${cwd})`,
  );
}
