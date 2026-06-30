# test-warden

An MCP server that keeps a **jest** or **vitest** watch process warm and lets a coding agent pilot it: rerun all, rerun failed, filter by file/test name, and read structured results — without paying cold-start on every run.

## Why

Agents normally run `jest` / `vitest run` fresh each time, eating the full cold start (transform + module graph) on every check. Watch mode keeps that warm, but its command channel is keyboard-only and dies without a TTY. This server gives the watcher a real PTY (via `node-pty`) and exposes the commands as MCP tools, so the agent gets watch-mode speed through normal tool calls.

## Install

Requires Node ≥ 20. `node-pty` builds a native addon on install (needs a C++ toolchain; prebuilds cover common platforms).

The recommended setup uses `npx` (below), which runs the server from npm's own cache — node-pty builds there regardless of your project's package manager, so **pnpm and yarn users need no extra steps**.

The native build only matters if you install `test-warden` as a project dependency. With pnpm v10 that build is skipped by default (server then fails with `Failed to load native module: pty.node`); approve it once with `pnpm approve-builds` (select node-pty) and `pnpm rebuild node-pty`, or add `"pnpm": { "onlyBuiltDependencies": ["node-pty"] }` to `package.json` and reinstall.

The fastest setup — run once in your project root to register the MCP server (`.mcp.json`) and the failure hook (`.claude/settings.json`), merging into any existing config:

```sh
npx -y test-warden init
```

Or configure manually:

```jsonc
// in your MCP client config (e.g. .mcp.json / Claude Code)
{
  "mcpServers": {
    "test-watch": {
      "command": "npx",
      "args": ["-y", "test-warden"],
    },
  },
}
```

## Tools

| Tool           | Args                                        | Does                                                             |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `start_watch`  | `cwd`, `runner?` (`jest`\|`vitest`), `args?`, `env?` | Launch a warm watch session in `cwd`. Runner auto-detected from `cwd`'s `package.json`; pass `runner` only to override. |
| `run_all`      | `cwd?`                                       | Rerun the whole suite.                                           |
| `run_failed`   | `cwd?`                                       | Rerun only previously failed tests.                             |
| `run_filtered` | `pattern`, `by` (`path`\|`name`), `cwd?`     | Rerun tests matching a filter.                                   |
| `get_results`  | `cwd?`                                       | Latest run as JSON: `{ total, passed, failed, ok, failures[] }`. |
| `tail_log`     | `cwd?`                                       | Recent raw watcher output (debugging).                           |
| `stop_watch`   | `cwd?`                                       | Stop one session, or all when `cwd` is omitted.                 |

`get_results` reads jest's `AggregatedResult` (via a bundled reporter) and vitest's `--reporter=json` — normalized to the same shape.

**Env vars:** tests often rely on env set in the `test` script (e.g. `"test": "TZ=UTC jest"` for stable dates). Since the server launches the runner binary directly, it reads those inline assignments (including a `cross-env` prefix) from the project's `test` script and applies them — so you don't get false negatives. Env set inside jest/vitest *config* already works. For file-loaded vars (dotenv-cli, env-cmd) or one-off overrides, pass `env` to `start_watch`.

**Monorepos:** one warm session per `cwd`, so you can watch several at once (e.g. `mobile` on jest and `api` on vitest concurrently). The runner is detected per-`cwd`, and the binary is resolved from `node_modules/.bin` walking up to the workspace root (so hoisted installs resolve). The `cwd` arg on the other tools picks which session — omit it when only one is running. The failure hook reports each workspace independently, so a green run in one never hides a red run in another.

## Failure notifications (optional)

> **The bundled hooks are Claude Code specific.** The MCP server (the tools above) is
> agent-agnostic standard MCP; only the optional hooks below target Claude Code. They
> emit Claude's `additionalContext` envelope, the only hook channel that reaches the
> model. Agent-specific output lives behind one function, `hooks/emit.mjs` — that's the
> seam to branch for another agent later.

MCP servers can't push to the agent on their own — the agent only reacts to a tool
return or a client-side hook. So failures are surfaced via a bundled `PostToolUse`
hook: after any tool call, it peeks at the latest run and, if a *new* run is failing,
injects a one-line note into the agent's context (non-blocking — the agent decides).
Add to your project's `.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node node_modules/test-warden/hooks/notify-on-fail.mjs"
          }
        ]
      }
    ]
  }
}
```

Fires once per failing run (deduped by results-file mtime); silent while green. `npx test-warden init` adds this for you.

## Auto-start on edit (optional)

A second bundled hook, `nudge-watch.mjs` (matcher `Edit|Write`, also Claude Code specific), removes the "did I start the watcher?" step: when you edit a file inside a jest/vitest package that isn't being watched, it nudges the agent to call `start_watch` for that exact package (cwd + detected runner). A hook can't call an MCP tool or reach the server's in-memory session, so it can't start the watcher itself — it prompts the agent, which then makes the call. Fires once per package dir; silent if a watcher for it already exists or the file isn't in a test package. `npx test-warden init` wires it up:

```jsonc
{
  "matcher": "Edit|Write",
  "hooks": [
    { "type": "command", "command": "node node_modules/test-warden/hooks/nudge-watch.mjs" }
  ]
}
```

## Limitations

- PTY uses `node-pty`; Windows support follows node-pty's (works, but less exercised here).
- A run takes a moment; after a `run_*` call, poll `get_results` until it returns counts.

## License

MIT
