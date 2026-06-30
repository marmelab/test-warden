// `test-warden init` — wire this MCP server + failure hook into a project.
// Merges into existing config (never clobbers other keys); idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Absolute path to the bundled hook, so the hook command works regardless of cwd.
const HOOK = path.join(HERE, "..", "hooks", "notify-on-fail.mjs");

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

  // 2) Add the PostToolUse hook (Claude Code), unless an identical one is present.
  patchJson(path.join(cwd, ".claude", "settings.json"), (c) => {
    const cmd = `node ${HOOK}`;
    const post = c.hooks?.PostToolUse ?? [];
    if (post.some((g) => g.hooks?.some((h) => h.command === cmd))) return c;
    return {
      ...c,
      hooks: {
        ...c.hooks,
        PostToolUse: [
          ...post,
          { matcher: "*", hooks: [{ type: "command", command: cmd }] },
        ],
      },
    };
  });

  console.log(
    `test-warden: registered MCP server in .mcp.json and failure hook in .claude/settings.json (${cwd})`,
  );
}
