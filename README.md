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

`init` also bootstraps **`test-warden.config.js`** in the project root — a best-effort detection of your setup (jest or vitest, plus any inline env in the `test` script) that you then own and edit. See [Configuration](#configuration): the file is **required**, and the server validates it on startup and refuses to start without it.

Or configure the MCP client manually:

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

## Configuration

Everything the server knows about your tests lives in one file, **`test-warden.config.js`**, next to `.mcp.json` in the project root. There is **no runtime auto-detection**: the server reads and validates this file once at startup (zod schema) and **exits with an explanatory error if it is missing or invalid** — a wrong config fails loudly instead of guessing.

```js
// test-warden.config.js — one entry per package/workspace whose tests can be run
export default [
  {
    dir: ".",
    runner: "vitest",
    args: "",
    env: { TZ: "UTC" },
  },
  {
    dir: "packages/api",
    runner: "jest",
    args: "--config jest.integration.config.js",
    env: { DATABASE_URL: "postgres://localhost:5432/test" },
    bin: "packages/api/tools/jest-wrapper",
  },
];
```

The file is a JS module (use `module.exports = [...]` in CommonJS projects, `export default [...]` under `"type": "module"`) exporting an array of entries — at least one. Keys:

| Key      | Required | Meaning                                                                                                                                                                                          |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dir`    | no (default `"."`) | Directory the tests run in, relative to this file. This is the `cwd` tools target; one watch session per entry. Monorepo: one entry per package.                                        |
| `runner` | **yes**  | `"jest"` or `"vitest"` — the only supported runners. The server drives the runner's own watch mode, so the entry must name which one.                                                             |
| `args`   | no (default `""`)  | Extra CLI flags appended to every run in this dir — custom config file (`--config …`), `--runInBand`, a project selector, etc.                                                          |
| `env`    | no (default `{}`)  | Env vars (string values) set for the runner. Put here what your `test` script or a `.env` file normally provides (`TZ`, `NODE_OPTIONS`, database URLs, …); bootstrap pre-fills inline vars from the `test` script. |
| `bin`    | no       | Path to the runner binary, relative to this file — for wrappers or unusual layouts. Default: the nearest `node_modules/.bin/<runner>` walking up from `dir` (hoisted monorepo installs resolve).   |

Unknown keys are rejected (validation catches typos). To (re)generate the file from detection, run `npx test-warden bootstrap` — unlike `init` (which only writes it when absent), **`bootstrap` overwrites the existing file** and prints a warning when it does. After editing the config, restart the MCP server (e.g. reconnect the client) so it re-reads the file.

> **Note for agents/LLMs editing this file:** to make a new package's tests runnable, append an entry with its `dir` and `runner`; to fix a failing setup, adjust `args`/`env`/`bin` on the existing entry — never invent other keys. The server error message tells you which entry and key failed validation.

## Tools

| Tool           | Args                                        | Does                                                             |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `start_watch`  | `cwd`, `args?`, `env?`                       | Launch a warm watch session in `cwd`, which must match a configured `dir`. `args`/`env` extend that entry per-call. |
| `run_all`      | `cwd?`                                       | Rerun the whole suite.                                           |
| `run_failed`   | `cwd?`                                       | Rerun only previously failed tests.                             |
| `run_filtered` | `pattern`, `by` (`path`\|`name`), `cwd?`     | Rerun tests matching a filter.                                   |
| `get_results`  | `cwd?`                                       | Latest run as JSON: `{ total, passed, failed, ok, failures[] }`. |
| `tail_log`     | `cwd?`                                       | Recent raw watcher output (debugging).                           |
| `stop_watch`   | `cwd?`                                       | Stop one session, or all when `cwd` is omitted.                 |

`get_results` reads jest's `AggregatedResult` (via a bundled reporter) and vitest's `--reporter=json` — normalized to the same shape.

**Env vars:** tests often rely on env set outside jest/vitest config (e.g. `"test": "TZ=UTC jest"` for stable dates, or a `.env` loaded by dotenv-cli). The server launches the runner binary directly, so those vars must be listed in the config entry's `env` — `bootstrap` pre-fills the inline ones (including a `cross-env` prefix) from the `test` script; add file-loaded ones by hand. Env set inside jest/vitest *config* already works. For one-off overrides, pass `env` to `start_watch`.

**Suite setup/teardown:** watchers are stopped gracefully — the server presses `q` in the watch UI and waits for the runner to exit — so `globalSetup` teardowns run to completion (a postgres started by your vitest setup gets stopped and releases its port before anything else starts). A hard kill only happens if the runner ignores `q` for 10s (`TEST_WARDEN_QUIT_GRACE_MS` overrides). This applies to `stop_watch`, restarts, the 30-minute idle stop, and session shutdown alike.

**Monorepos:** one warm session per `cwd`, so you can watch several at once (e.g. `mobile` on jest and `api` on vitest concurrently). Add one `test-warden.config.js` entry per package (`dir: "packages/app"`, …). The `cwd` arg on the other tools picks which session — omit it when only one is running. The failure hook reports each workspace independently, so a green run in one never hides a red run in another.

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
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/test-warden/notify-on-fail.mjs\""
          }
        ]
      }
    ]
  }
}
```

Fires once per failing run (deduped by results-file mtime); silent while green. `npx test-warden init` adds this for you — it copies the hook files into `.claude/hooks/test-warden/` so the commands are stable and committable (no dependence on `node_modules` layout or the npx cache). Installed as a dependency, `node node_modules/test-warden/hooks/notify-on-fail.mjs` works too.

## Auto-start on edit (optional)

A second bundled hook, `nudge-watch.mjs` (matcher `Edit|Write`, also Claude Code specific), removes the "did I start the watcher?" step: when you edit a file inside a dir that `test-warden.config.js` declares testable but that isn't being watched, it nudges the agent to call `start_watch` for that exact entry (cwd + configured runner). It follows the config only — silent for files outside every configured `dir`; if the config is *invalid*, it surfaces the validation error to the agent instead, so it gets fixed. A hook can't call an MCP tool or reach the server's in-memory session, so it can't start the watcher itself — it prompts the agent, which then makes the call. `npx test-warden init` wires it up:

```jsonc
{
  "matcher": "Edit|Write",
  "hooks": [
    { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/test-warden/nudge-watch.mjs\"" }
  ]
}
```

## Session lifecycle — one active session per project

Warm watchers are real processes with real side effects (a suite that boots a database
binds its port), so stale ones must never outlive their session. Three layers, newest
session always wins:

- **The server dies with its client.** When the session ends (stdin closes, or
  SIGTERM/SIGINT), the server kills its watchers, removes their live markers, and
  exits — no zombie keeps rerunning tests after the session is gone.
- **`start_watch` takes over.** If another live server still watches the target dir
  (a session you forgot open), the new server SIGTERMs it — triggering that same
  cleanup — and starts its own watcher.
- **A `SessionStart` hook surfaces leftovers up front.** `reset-watch.mjs` (matcher
  `startup|resume`, wired by `init`) detects watchers other sessions still hold on
  this project before the new session runs anything. It never kills by itself — the
  other session may be a window you're still using — it tells the agent to ask you
  first, explaining the caveat of keeping it (the old watcher auto-reruns tests on
  every edit, colliding on shared resources like a fixed DB port). Markers of dead
  servers are reaped silently.

## Limitations

- POSIX only: the watcher is launched through `/bin/sh`, so only macOS and Linux are supported. Windows is not.
- A run takes a moment; after a `run_*` call, poll `get_results` until it returns counts.

## License

MIT
