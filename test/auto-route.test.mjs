import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "uq-auto-"));
process.env.FIELDTEST_DATA = join(root, "data");
process.env.HOME = join(root, "home");
mkdirSync(join(process.env.HOME, ".config", "fieldtest"), { recursive: true });
writeFileSync(join(process.env.HOME, ".config", "fieldtest", "slack.env"), "SLACK_BOT_TOKEN=xoxb-test\nSLACK_USER_ID=U1\n");
mkdirSync(join(process.env.FIELDTEST_DATA, "run"), { recursive: true });
const { MONOREPO, useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe(MONOREPO);
// The human's clone is a throwaway repository here, so nothing reaches the real one.
const myClone = join(root, "clone");
mkdirSync(myClone);
execFileSync("git", ["init", "-q"], { cwd: myClone });
writeFileSync(join(process.env.FIELDTEST_DATA, "config.json"), JSON.stringify({ myClone }));

// A fake gh: an open, mergeable PR whose required ci passed. Posting a review comment returns id 555.
// `pr diff N` prints diff-N.patch; every call is recorded.
const HEAD = "abc1234def5678";
const bin = join(root, "bin");
mkdirSync(bin);
const calls = join(bin, "calls.log");
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh
echo "$*" >> ${calls}
case "$1 $2" in
  "pr view") case "$*" in *mergeCommit*) echo m1;; *statusCheckRollup*) echo '{"statusCheckRollup":[{"__typename":"CheckRun","name":"ci","status":"COMPLETED","conclusion":"SUCCESS","workflowName":"ci","startedAt":"2026-10-21T00:00:00Z","detailsUrl":"https://github.com/o/r/actions/runs/1/job/1"}]}';; *) echo '{"number":'$3',"state":"OPEN","isDraft":false,"headRefOid":"${HEAD}","mergeable":"MERGEABLE","url":"u","body":""}';; esac;;
  "pr diff") cat ${bin}/diff-$3.patch;;
  "pr comment"|"pr merge"|"pr update-branch") cat >/dev/null;;
  *) case "$*" in
    *rules/branches/main*) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci"}]}}]';;
    *"-X POST"*pulls/*/comments*) cat >/dev/null; echo '{"id":555}';;
    *pulls/*/comments*) cat ${bin}/inline.jsonl 2>/dev/null;;
    *compare/*) cat ${bin}/behind 2>/dev/null || echo 0;;
  esac;;
esac
`,
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
globalThis.fetch = async (url) => ({ status: 200, json: async () => ({ ok: true, ...(url.endsWith("conversations.open") ? { channel: { id: "D1" } } : { ts: "1.0" }) }) });

const store = await import("../lib/store.mjs");
const { autoApprove, checkReview, finalize } = await import("../lib/watch.mjs");
const { pendingReviews, writeReviewResult } = await import("../lib/review.mjs");

const file = (path, lines) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...lines].join("\n");
const small = file("apps/web/src/components/a.tsx", ["-  return a;", "+  return b;"]);
const ghCalls = () => readFileSync(calls, "utf8");
const base = { screen: "chat", title: "t", severity: "low", kind: "functional", attempt: 1, implement: { engine: "claude" } };

function awaiting(id, extra, patch) {
  store.createTicket({ id, status: "awaiting", ...base, ...extra });
  const adir = join(store.ticketDir(id), "attempts", "1");
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, "diff.patch"), patch);
}

function finalReview(id, n, patch, extra = {}) {
  store.createTicket({ id, status: "final-review", ...base, pr: { number: n, url: "u", branch: `fix/${id}`, head: HEAD, round: 0 }, route: { auto: true, reasons: [], attempt: 1 }, prNote: null, ...extra });
  writeFileSync(join(bin, `diff-${n}.patch`), patch);
}

test("awaiting candidates get a route; the automatic one is approved and doesn't hold the loop", async () => {
  awaiting("QA-0001", { kind: "visual" }, small);
  awaiting("QA-0002", {}, small);
  awaiting("QA-0003", { humanTouched: true }, small);
  // The candidate bundle is missing here, so the approval itself fails and says which ticket it was.
  await assert.rejects(autoApprove(), /^Error: QA-0002 자동 진행 실패: /);
  assert.deepEqual(store.readTicket("QA-0001").route, { auto: false, reasons: ["시각 수정"], attempt: 1 });
  assert.deepEqual(store.readTicket("QA-0002").route, { auto: true, reasons: [], attempt: 1 });
  assert.deepEqual(store.readTicket("QA-0003").route.reasons, ["사람이 수정을 요청함"]);
  assert.equal(store.approvalWaiting(), 2);
});

test("a clean PR on the automatic route merges without the final review", async () => {
  writeFileSync(calls, "");
  finalReview("QA-0010", 10, small);
  assert.equal(await finalize(store.readTicket("QA-0010")), "merged");
  const t = store.readTicket("QA-0010");
  assert.equal(t.status, "merged");
  assert.equal(t.autoMerge.auto, true);
  assert.match(ghCalls(), /^pr comment 10 /m);
  assert.match(ghCalls(), /^pr merge 10 .*--squash --match-head-commit abc1234def5678$/m);
});

test("a clean PR below high that left the route merges without the final review", async () => {
  writeFileSync(calls, "");
  finalReview("QA-0014", 14, file("apps/web/src/components/notice.tsx", ['+  "저장하지 못했습니다"']));
  assert.equal(await finalize(store.readTicket("QA-0014")), "merged");
  const t = store.readTicket("QA-0014");
  assert.equal(t.route.auto, false);
  assert.deepEqual(t.autoMerge.final, true);
  assert.match(ghCalls(), /^pr merge 14 .*--squash/m);
});

test("a high-severity PR that left the route, or a PR that kept a problem, waits for the human", async () => {
  writeFileSync(calls, "");
  finalReview("QA-0011", 11, file("apps/web/src/components/notice.tsx", ['+  "저장하지 못했습니다"']), { severity: "high" });
  assert.equal(await finalize(store.readTicket("QA-0011")), "notified");
  let t = store.readTicket("QA-0011");
  assert.equal(t.status, "final-review");
  assert.deepEqual(t.route.reasons, ["심각도 high", "화면 문구 변경 (notice.tsx)"]);
  assert.equal(t.route.auto, false);
  assert.equal(t.autoMerge, undefined);
  assert.doesNotMatch(ghCalls(), /pr merge/);
  assert.equal(await finalize(t), "waiting-human", "the route is judged once");

  finalReview("QA-0012", 12, small, { prNote: "수정 라운드 10회 뒤에도 남은 것: Codex 지적 1개" });
  await finalize(store.readTicket("QA-0012"));
  t = store.readTicket("QA-0012");
  assert.deepEqual(t.route.reasons, ["남은 문제: 수정 라운드 10회 뒤에도 남은 것: Codex 지적 1개"]);
  assert.doesNotMatch(ghCalls(), /pr diff 12/);
});

test("a fix round that grows an automatic merge past the limits stops it", async () => {
  writeFileSync(calls, "");
  const big = file("apps/web/src/components/a.tsx", Array.from({ length: 90 }, (_, i) => `+  const v${i} = ${i};`));
  finalReview("QA-0013", 13, big, { autoMerge: { at: "x", auto: true } });
  assert.equal(await finalize(store.readTicket("QA-0013")), "auto-merge-stopped");
  const t = store.readTicket("QA-0013");
  assert.equal(t.autoMerge, null);
  assert.equal(t.route.auto, false);
  assert.match(t.prNote, /^자동 머지 멈춤: 자동 머지 기준을 벗어남 \(소스 90줄 \(자동 상한 80\)\)$/);
  assert.doesNotMatch(ghCalls(), /pr merge/);
});

test("a PR head without a server review is asked for and waits", async () => {
  store.createTicket({ id: "QA-0020", status: "pr-review", ...base, pr: { number: 20, url: "u", branch: "fix/QA-0020", head: HEAD, round: 0 } });
  assert.equal(await checkReview(store.readTicket("QA-0020")), "waiting");
  assert.deepEqual(pendingReviews().filter((r) => r.id === "QA-0020"), [{ id: "QA-0020", head: HEAD }]);
});

test("the agent's review is posted and an open finding starts a fix round", async () => {
  writeFileSync(calls, "");
  store.createTicket({ id: "QA-0021", status: "pr-review", ...base, pr: { number: 21, url: "u", branch: "fix/QA-0021", head: HEAD, round: 0 } });
  writeReviewResult("QA-0021", HEAD, { summary: "한 곳", findings: [{ path: "apps/web/src/components/a.tsx", line: 1, body: "**P1** 두 번 보낸다\n\n이유", anchor: "line" }] });
  writeFileSync(join(bin, "inline.jsonl"), `${JSON.stringify({ id: 555, path: "apps/web/src/components/a.tsx", line: 1, body: "**P1** 두 번 보낸다" })}\n`);
  await checkReview(store.readTicket("QA-0021"));
  assert.match(ghCalls(), /-X POST repos\/acme\/shop\/pulls\/21\/comments --input -/);
  assert.match(ghCalls(), /^pr comment 21 /m);
  assert.equal(store.readTicket("QA-0021").status, "pr-fixing");
  const req = JSON.parse(readFileSync(join(store.ticketDir("QA-0021"), "pr-rounds", "1", "request.json"), "utf8"));
  assert.deepEqual(req.findings.map((f) => f.id), [555]);
  rmSync(join(bin, "inline.jsonl"));
});
