// test-warden.config.js — REQUIRED: how test-warden runs this project's tests.
// The main suite (`npm test`) is node:test, which test-warden doesn't drive; the
// runnable jest/vitest dirs are the demo packages, handy for exercising the server.
export default [
  {
    dir: "demo/vitest",
    runner: "vitest",
    args: "",
    env: {},
  },
  {
    dir: "demo/jest",
    runner: "jest",
    args: "",
    env: {},
  },
];
