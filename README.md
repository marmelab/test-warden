# test-watch-mcp

An MCP server that keeps a **jest** or **vitest** watch process warm and lets a coding agent pilot it: rerun all, rerun failed, filter by file/test name, and read structured results — without paying cold-start on every run.

## Why

Agents normally run `jest` / `vitest run` fresh each time, eating the full cold start (transform + module graph) on every check. Watch mode keeps that warm, but its command channel is keyboard-only and dies without a TTY. This server gives the watcher a real PTY (via `node-pty`) and exposes the commands as MCP tools, so the agent gets watch-mode speed through normal tool calls.

## Install

Requires Node ≥ 20. `node-pty` builds a native addon on install (needs a C++ toolchain; prebuilds cover common platforms).

```jsonc
// in your MCP client config (e.g. .mcp.json / Claude Code)
{
  "mcpServers": {
    "test-watch": {
      "command": "npx",
      "args": ["-y", "test-watch-mcp"],
    },
  },
}
```

## Tools

| Tool           | Args                                        | Does                                                             |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `start_watch`  | `runner` (`jest`\|`vitest`), `cwd`, `args?` | Launch a warm watch session in `cwd`.                            |
| `run_all`      | —                                           | Rerun the whole suite.                                           |
| `run_failed`   | —                                           | Rerun only previously failed tests.                              |
| `run_filtered` | `pattern`, `by` (`path`\|`name`)            | Rerun tests matching a filter.                                   |
| `get_results`  | —                                           | Latest run as JSON: `{ total, passed, failed, ok, failures[] }`. |
| `tail_log`     | —                                           | Recent raw watcher output (debugging).                           |
| `stop_watch`   | —                                           | Stop the session.                                                |

One warm session per server process. `get_results` reads jest's `AggregatedResult` (via a bundled reporter) and vitest's `--reporter=json` — normalized to the same shape.

## Limitations

- PTY uses `node-pty`; Windows support follows node-pty's (works, but less exercised here).
- A run takes a moment; after a `run_*` call, poll `get_results` until it returns counts.

## License

MIT
