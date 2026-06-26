// Jest reporter: dump each run's AggregatedResult to TEST_WATCH_MCP_OUT as JSON.
// Jest's AggregatedResult is the same shape Vitest's json reporter emits, so the
// MCP server can parse both identically. Registered via `--reporters <this file>`.
const fs = require("fs");

class TestWatchMcpReporter {
  onRunComplete(_contexts, results) {
    const out = process.env.TEST_WATCH_MCP_OUT;
    if (!out) return;
    try {
      fs.writeFileSync(out, JSON.stringify(results));
    } catch {
      // ponytail: a failed write just means stale results; next run overwrites.
    }
  }
}

module.exports = TestWatchMcpReporter;
