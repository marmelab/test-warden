// Pure, side-effect-free helpers — extracted so they're testable without
// importing index.js (which opens an MCP transport on import).

export function buildCommand(runner, resultsFile, reporterPath, extra) {
  const args = extra ? ` ${extra}` : "";
  if (runner === "jest") {
    // `--reporters` is a greedy array flag — keep positional args before it, or jest
    // parses them as extra reporter modules.
    return `./node_modules/.bin/jest --watchAll${args} --reporters default --reporters ${reporterPath}`;
  }
  return `./node_modules/.bin/vitest --watch --reporter=default --reporter=json --outputFile=${resultsFile}${args}`;
}

// Normalize a parsed jest AggregatedResult / vitest json blob (same shape) into
// the compact summary the MCP server returns.
export function normalizeResults(r) {
  const failures = [];
  for (const suite of r.testResults ?? []) {
    for (const a of suite.assertionResults ?? []) {
      if (a.status === "failed") {
        failures.push({
          test: a.fullName || a.title,
          file: suite.name,
          message: (a.failureMessages ?? []).join("\n").slice(0, 2000),
        });
      }
    }
  }
  return {
    total: r.numTotalTests ?? 0,
    passed: r.numPassedTests ?? 0,
    failed: r.numFailedTests ?? 0,
    suitesFailed: r.numFailedTestSuites ?? 0,
    ok: (r.numFailedTests ?? 0) === 0 && (r.numFailedTestSuites ?? 0) === 0,
    failures,
  };
}
