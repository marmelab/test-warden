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

// Normalize a parsed results blob into the compact summary the server returns.
// Two near-identical shapes show up: jest's reporter-API AggregatedResult uses
// `testFilePath` + a nested `testResults` array per suite; vitest's json reporter
// (and jest's `--json` CLI) use `name` + `assertionResults`. Accept either.
export function normalizeResults(r) {
  const failures = [];
  for (const suite of r.testResults ?? []) {
    const assertions = suite.assertionResults ?? suite.testResults ?? [];
    const file = suite.name ?? suite.testFilePath;
    for (const a of assertions) {
      if (a.status === "failed") {
        failures.push({
          test: a.fullName || a.title,
          file,
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
