import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-mergestep-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { mergeStep } = await import("../lib/watch.mjs");

const ok = { mergeable: "MERGEABLE", checks: { pending: false, failing: [] }, codex: { done: true, findings: [] }, round: 0 };

test("a requested merge merges once clean; being behind main is handled by the local check", () => {
  assert.deepEqual(mergeStep(ok), { merge: true });
  assert.deepEqual(mergeStep({ ...ok, codex: { done: false, findings: [] } }), { merge: true });
});

test("it waits for CI", () => {
  assert.deepEqual(mergeStep({ ...ok, checks: { pending: true, failing: [] } }), { wait: true });
});

test("a conflict, CI failure or review finding goes to the fix rounds while any are left", () => {
  assert.match(mergeStep({ ...ok, checks: { pending: false, failing: [{ name: "e2e" }] } }).fix, /CI 실패 \(e2e\)/);
  assert.match(mergeStep({ ...ok, mergeable: "CONFLICTING" }).fix, /충돌/);
  assert.match(mergeStep({ ...ok, codex: { done: true, findings: [{}] } }).fix, /리뷰 지적 1개/);
  assert.match(mergeStep({ ...ok, checks: { pending: true, failing: [{ name: "ci" }] } }).fix, /CI 실패/);
  assert.match(mergeStep({ ...ok, round: 9, codex: { done: true, findings: [{}] } }).fix, /리뷰 지적/);
  assert.match(mergeStep({ ...ok, round: 10, codex: { done: true, findings: [{}] } }).stop, /리뷰 지적 1개\. 자동 수정 라운드 10회를 다 씀/);
});
