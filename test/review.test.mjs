import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-review-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { REVIEW_MARKER, anchorFindings, pendingReviews, queueReview, reviewState, rightLines, writeReviewResult, writePosted } = await import("../lib/review.mjs");
const { createTicket, readTicket } = await import("../lib/store.mjs");

const DIFF = [
  "diff --git a/web/src/a.ts b/web/src/a.ts",
  "--- a/web/src/a.ts",
  "+++ b/web/src/a.ts",
  "@@ -10,3 +10,4 @@",
  " keep();",
  "-old();",
  "+fresh();",
  "+more();",
  " tail();",
].join("\n");

test("right-side lines of a diff are the context and added lines of each hunk", () => {
  assert.deepEqual([...rightLines(DIFF).get("web/src/a.ts")], [10, 11, 12, 13]);
});

test("a finding on a changed line is inline, elsewhere in a changed file is file-level, outside the diff goes to the summary", () => {
  const findings = [
    { path: "web/src/a.ts", line: 11, body: "a" },
    { path: "web/src/a.ts", line: 40, body: "b" },
    { path: "web/src/other.ts", line: 3, body: "c" },
  ];
  assert.deepEqual(
    anchorFindings(findings, DIFF).map((f) => f.anchor),
    ["line", "file", "summary"],
  );
});

test("a queued review is asked for once and stays pending until its result is written", () => {
  createTicket({ id: "QA-0001", status: "pr-review", title: "t", attempt: 1, pr: { number: 7, round: 0 } });
  const t = readTicket("QA-0001");
  assert.equal(queueReview(t, "abc"), true);
  assert.equal(queueReview(t, "abc"), false);
  assert.deepEqual(pendingReviews(), [{ id: "QA-0001", head: "abc" }]);
  writeReviewResult("QA-0001", "abc", { findings: [], summary: "깨끗함" });
  assert.deepEqual(pendingReviews(), []);
});

test("review state: posted findings stay open until a reply answers them, whoever wrote the reply", async () => {
  const t = readTicket("QA-0001");
  assert.equal((await reviewState(t, "def", { inline: [] })).done, false);
  writePosted("QA-0001", "def", { ids: [101, 102] });
  const inline = [
    { id: 101, path: "web/src/a.ts", line: 11, body: `x\n${REVIEW_MARKER}`, user: { login: "alice" } },
    { id: 102, path: "web/src/a.ts", line: 12, body: `y\n${REVIEW_MARKER}`, user: { login: "alice" } },
    { id: 201, in_reply_to_id: 101, body: "accepted risk", user: { login: "alice" } },
  ];
  const state = await reviewState(t, "def", { inline });
  assert.equal(state.done, true);
  assert.deepEqual(state.findings.map((f) => f.id), [102]);
});

test("only P0 and P1 findings become PR comments, each anchored to the diff", async () => {
  const { reviewFindings } = await import("../lib/review.mjs");
  const json = {
    summary: "s",
    findings: [
      { priority: "P1", path: "web/src/a.ts", line: 12, title: "저장이 두 번 된다", body: "두 번 누르면 두 번 보낸다." },
      { priority: "P2", path: "web/src/a.ts", line: 11, title: "이름", body: "취향" },
    ],
  };
  const out = reviewFindings(json, DIFF);
  assert.equal(out.length, 1);
  assert.equal(out[0].anchor, "line");
  assert.match(out[0].body, /^\*\*P1\*\* 저장이 두 번 된다\n\n두 번 누르면 두 번 보낸다\.$/);
});

test("reviews are asked only for PRs still in review", async () => {
  createTicket({ id: "QA-0002", status: "merged", title: "t", attempt: 1, pr: { number: 8, round: 0 } });
  queueReview(readTicket("QA-0002"), "fff");
  assert.ok(!pendingReviews().some((r) => r.id === "QA-0002"));
});

test("a review that keeps failing ends as failed after three tries instead of blocking the lane", async () => {
  const { reviewFailed } = await import("../lib/review.mjs");
  createTicket({ id: "QA-0003", status: "pr-review", title: "t", attempt: 1, pr: { number: 9, round: 0 } });
  queueReview(readTicket("QA-0003"), "aaa");
  assert.equal(reviewFailed("QA-0003", "aaa", "checkout 실패"), false);
  assert.equal(reviewFailed("QA-0003", "aaa", "checkout 실패"), false);
  assert.equal(reviewFailed("QA-0003", "aaa", "checkout 실패"), true);
  assert.ok(!pendingReviews().some((r) => r.id === "QA-0003"));
  const state = await reviewState(readTicket("QA-0003"), "aaa", { inline: [] });
  assert.equal(state.done, false);
});

test("posting resumes where it stopped and moves a rejected line comment to the file, then the summary", async () => {
  const { postReview } = await import("../lib/review.mjs");
  createTicket({ id: "QA-0004", status: "pr-review", title: "t", attempt: 1, pr: { number: 10, round: 0 } });
  writeReviewResult("QA-0004", "bbb", {
    summary: "s",
    findings: [
      { path: "a.ts", line: 1, body: "one", anchor: "line" },
      { path: "a.ts", line: 2, body: "two", anchor: "line" },
      { path: "b.ts", line: 3, body: "three", anchor: "line" },
    ],
  });
  const calls = [];
  let fail = true;
  const post = async (n, c) => {
    calls.push(`${c.path}:${c.line ?? "file"}`);
    if (c.path === "a.ts" && c.line === 2) throw new Error("422 line not in diff");
    if (c.path === "b.ts" && fail) {
      fail = false;
      throw new Error("network down");
    }
    return { id: calls.length };
  };
  const comment = async () => {};
  await assert.rejects(postReview(readTicket("QA-0004"), "bbb", { post, comment }), /network down/);
  const ids = await postReview(readTicket("QA-0004"), "bbb", { post, comment });
  assert.deepEqual(calls, ["a.ts:1", "a.ts:2", "a.ts:file", "b.ts:3", "b.ts:3", "b.ts:file"].slice(0, calls.length));
  assert.equal(calls.filter((c) => c === "a.ts:1").length, 1, "a posted comment is not posted again");
  assert.equal(ids.length, 3);
});
