import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-aftermerge-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { ciSuspects, describeBroken, noteFailures, readAfterMerge, recordMerge, recovered } = await import("../lib/aftermerge.mjs");

const merge = (ticket, pr, fields) => ({ ticket, pr, sha: `${pr}`.padEnd(40, "0"), ci: null, ...fields });

test("each merge waits for its own main ci", () => {
  recordMerge({ ticket: "QA-0045", pr: 339, sha: "a".repeat(40) });
  recordMerge({ ticket: "QA-0051", pr: 349, sha: "b".repeat(40) });
  assert.deepEqual(readAfterMerge().merges.map((m) => [m.pr, m.ci]), [[339, null], [349, null]]);
});

test("a failed main ci names the merges since the last one that passed", () => {
  const merges = [merge("QA-1", 1, { ci: "success" }), merge("QA-2", 2, { ci: null }), merge("QA-3", 3, { ci: "failure" })];
  assert.deepEqual(ciSuspects(merges, 2).map((m) => m.ticket), ["QA-2", "QA-3"]);
  assert.deepEqual(ciSuspects([merge("QA-9", 9, { ci: "failure" })], 0).map((m) => m.ticket), ["QA-9"]);
});

test("failures of one cause stay one incident and are reported once", () => {
  const s = {
    merges: [merge("QA-1", 1, { ci: "failure", ciUrl: "u1" }), merge("QA-2", 2, { ci: "failure", ciUrl: "u2" })],
    broken: null,
  };
  noteFailures(s);
  assert.equal(s.broken.sha, "1".padEnd(40, "0"));
  assert.deepEqual(s.broken.suspects, ["QA-1 #1", "QA-2 #2"]);
  const at = s.broken.at;
  noteFailures(s);
  assert.equal(s.broken.at, at);
  assert.match(describeBroken(s.broken), /^머지 후 main CI 실패 \(1000000\)\. 원인 후보: QA-1 #1, QA-2 #2$/);
});

test("the hold clears only when the newest main run passes, a rerun of the failed one included", () => {
  assert.equal(recovered({ status: "completed", conclusion: "success", headSha: "a" }), true);
  assert.equal(recovered({ status: "in_progress", conclusion: "", headSha: "a" }), false);
  assert.equal(recovered({ status: "completed", conclusion: "failure", headSha: "a" }), false);
  assert.equal(recovered(null), false);
});
