import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listInstances, slugFor } from "../src/core.js";

// A .live marker as spawnWatcher writes it: "<pid>\n<cwd>".
const marker = (dir, slug, pid, cwd) =>
  fs.writeFileSync(path.join(dir, `test-warden-${slug}.live`), `${pid}\n${cwd}`);

test("listInstances: lists live markers, reaps dead ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ls-"));
  const cwd = "/some/project";
  const liveSlug = slugFor(cwd);
  marker(dir, liveSlug, process.pid, cwd); // our own pid — alive
  // A dead pid: 2^31-1 is not a real process, so process.kill(pid, 0) throws.
  const deadCwd = "/gone/project";
  const deadSlug = slugFor(deadCwd);
  marker(dir, deadSlug, 2147483647, deadCwd);
  // Noise that must be ignored.
  fs.writeFileSync(path.join(dir, "test-warden-abc.json"), "{}");
  fs.writeFileSync(path.join(dir, "unrelated.live"), "x");

  const rows = listInstances(dir);

  assert.equal(rows.length, 1, "only the live marker is listed");
  assert.deepEqual(rows[0], { pid: process.pid, slug: liveSlug, cwd });
  assert.equal(
    fs.existsSync(path.join(dir, `test-warden-${deadSlug}.live`)),
    false,
    "the dead marker was reaped",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
