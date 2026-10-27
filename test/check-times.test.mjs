import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceOf, summarizeCheckTimes, turboCache } from "../lib/check-times.mjs";

test("turbo's cache summary is read from the check output", () => {
  const out = "@acme/web:test: cache miss, executing 3901\n@acme/contracts:test: cache hit, replaying logs 9a41\n Tasks:    3 successful, 3 total\nCached:    2 cached, 3 total\n  Time:    1m34.546s";
  assert.deepEqual(turboCache(out, "web"), { cached: 2, total: 3, web: "miss" });
  assert.equal(turboCache(out.replace("web:test: cache miss", "web:test: cache hit"), "web").web, "hit");
  assert.equal(turboCache("Checked 900 files in 2s", "web"), null);
});

test("check times are medians of main's base checks per vCPU count, without failed runs or runs that replayed the web package", () => {
  const lines = [
    { check: "test", cores: 8, ms: 100_000, ok: true, load: 4, cached: 2, tasks: 3 },
    { check: "test", cores: 8, ms: 90_000, ok: true, load: 6, cached: 2, tasks: 3 },
    { check: "test", cores: 8, ms: 5_000, ok: false, load: 1 },
    { check: "typecheck", cores: 8, ms: 11, ok: true, load: 1, cached: 2, tasks: 2 },
    { check: "test", cores: 8, ms: 4_000, ok: true, load: 1, cached: 2, tasks: 3, web: "hit" },
    { check: "lint", cores: 16, ms: 20_000, ok: true, load: 2 },
    { check: "typecheck", cores: 8, ms: 5_000, ok: true, load: 1, cached: 1, tasks: 2, web: "miss", from: "gate" },
  ].map((l, i) => JSON.stringify({ at: `2026-10-24T0${i}:00:00.000Z`, from: "base", ...l }));
  const rows = summarizeCheckTimes(`${lines.join("\n")}\nnot json\n`);
  assert.deepEqual(
    rows.map((r) => [r.cores, r.check, r.runs, r.medianMs, r.lastMs, r.medianLoad]),
    [
      [8, "test", 2, 95_000, 90_000, 5],
      [16, "lint", 1, 20_000, 20_000, 2],
    ],
  );
});

test("a check's source comes from where its log is written", () => {
  assert.equal(sourceOf("/d/base-checks/abc.log"), "base");
  assert.equal(sourceOf("/d/run/merge-checks/QA-0001-abc.log"), "merge");
  assert.equal(sourceOf("/d/runs/work/1-F-0001/run.log"), "gate");
});
