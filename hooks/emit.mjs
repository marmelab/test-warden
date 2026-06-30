// CLAUDE CODE SPECIFIC. A PostToolUse hook reaches the model only through the
// `additionalContext` envelope — plain stdout shows in the transcript but the model
// never sees it. Since the hooks exist to tell the *agent* things, they target
// Claude Code for now. (The MCP server itself is agent-agnostic; only these hooks
// are Claude-specific.)
//
// This is the single seam for agent-specific hook output. To support another agent
// later, branch here (e.g. on a HOOK_AGENT env var) and emit that agent's format —
// nothing above this layer needs to change.
export function emitContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: text,
      },
    }),
  );
}
