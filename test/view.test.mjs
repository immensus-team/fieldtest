import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLIED_ONLY, actionsOf, blockedOf, cardOf, outcomeOf, checksSummary, columnOf, exploringOf, liveStep, parseLine, progressOf, repeatedFailure, stageOf } from "../lib/view.mjs";

const ticket = (status, extra = {}) => ({ id: "QA-0028", status, title: "t", severity: "low", pr: { number: 324, url: "u", round: 0 }, updatedAt: "2026-10-19T05:00:00.000Z", ...extra });
const line = (at, text) => ({ at, text });
const current = (p) => p.steps.find((s) => s.state === "current" || s.state === "failed");

test("each status lands in its board column and stage", () => {
  assert.equal(columnOf(ticket("needs-human")), "awaiting");
  assert.equal(columnOf(ticket("pr-push")), "working");
  assert.equal(columnOf(ticket("final-review")), "final");
  assert.equal(columnOf(ticket("closed")), "done");
  assert.equal(stageOf(ticket("pr-fixing", { pr: { number: 1, url: "u", round: 1 } })), "PR 수정 라운드 2");
  assert.equal(stageOf(ticket("grouped", { groupId: "QA-0018" })), "묶음 처리 중 (QA-0018)");
  assert.equal(stageOf(ticket("final-review", { autoMerge: { at: "x" } })), "자동 머지 중");
});

test("buttons follow the status; 수정 on a final-review PR is feedback", () => {
  assert.deepEqual(actionsOf(ticket("awaiting", { reviseAdvice: "a" })), ["approve", "reject", "revise", "adopt"]);
  assert.deepEqual(actionsOf(ticket("final-review", { severity: "high" })), ["merge", "feedback", "reject"]);
  assert.deepEqual(actionsOf(ticket("final-review")), [], "a clean PR below high merges without the final review");
  assert.deepEqual(actionsOf(ticket("final-review", { autoMerge: { at: "x" } })), []);
  assert.deepEqual(actionsOf(ticket("pr-review")), []);
});

test("a command waiting for watch shows as received and locks the buttons", () => {
  const t = ticket("final-review", { severity: "high" });
  assert.deepEqual(cardOf(t).actions, ["merge", "feedback", "reject"]);
  const card = cardOf(t, { queued: { verb: "머지", at: "2026-10-19T09:04:35.000Z", message: "watch 처리 대기" } });
  assert.equal(card.stage, "머지 요청 접수됨");
  assert.deepEqual(card.actions, []);
  assert.equal(card.progress.detail, "watch 처리 대기");
  assert.equal(card.progress.active, true);
  assert.equal(card.progress.since, "2026-10-19T09:04:35.000Z");
});

test("a command shows what it led to, up to the next command for the ticket", () => {
  const revise = { at: "2026-10-19T07:05:06.442Z", id: "QA-0044", verb: "수정", ok: true };
  const lines = [
    line("2026-10-19T05:19:47.108Z", '{"result":"ticket","ticket":"QA-0044","screen":"files"}'),
    line("2026-10-19T08:01:01.024Z", '[탐색] {"result":"revised","ticket":"QA-0044"}'),
    line("2026-10-19T09:00:00.000Z", "QA-0044 final-review: merged"),
  ];
  assert.deepEqual(outcomeOf(revise, lines), { at: "2026-10-19T08:01:01.024Z", ok: true, text: "재구현 끝남. 새 후보가 승인 대기" });
  assert.equal(outcomeOf(revise, lines, "2026-10-19T08:00:00.000Z"), null);
  assert.equal(outcomeOf({ ...revise, ok: false }, lines), null);
  const merge = { at: "2026-10-19T08:30:00.000Z", id: "QA-0044", verb: "머지", ok: true };
  assert.equal(outcomeOf(merge, lines).text, "머지됨");
  const failed = [line("2026-10-19T07:01:04.872Z", '{"result":"pr-fix-failed","ticket":"QA-0040","reason":"사람 판단 필요: x"}')];
  assert.equal(outcomeOf({ at: "2026-10-19T06:54:48.101Z", id: "QA-0040", verb: "수정", ok: true }, failed).text, "PR 수정 실패: 사람 판단 필요: x");
});

test("the same failure in a row is counted; another line in between resets it", () => {
  const fail = "QA-0028 pr-push 실패: git bundle verify failed (1)";
  const lines = [line("1", "QA-0028 pr-push: pr-review"), line("2", fail), line("3", fail), line("4", fail)];
  assert.deepEqual(repeatedFailure(lines, "QA-0028"), { count: 3, last: "4", text: "pr-push 실패: git bundle verify failed (1)" });
  assert.equal(repeatedFailure([...lines, line("5", "QA-0028 pr-push: pr-review")], "QA-0028"), null);
  assert.equal(repeatedFailure(lines.slice(0, 3), "QA-0028"), null);
  const b = blockedOf(ticket("pr-push"), lines);
  assert.equal(b.tone, "error");
  assert.equal(b.repeat.count, 3);
});

test("blocked reasons come from the ticket's notes", () => {
  assert.equal(blockedOf(ticket("final-review", { prNote: "수정 라운드 1 실패: 사람 판단 필요" })).tone, "error");
  assert.equal(blockedOf(ticket("final-review", { prNote: REPLIED_ONLY })).tone, "warn");
  assert.match(blockedOf(ticket("awaiting", { reviseNote: "검토자가 막음\n- 안내가 사라짐" })).text, /^재구현 실패: 검토자가 막음: 안내가 사라짐/);
  assert.equal(blockedOf(ticket("awaiting")), null);
  assert.equal(blockedOf(ticket("merged"), [line("1", "QA-0028 x 실패"), line("2", "QA-0028 x 실패"), line("3", "QA-0028 x 실패")]), null);
});

test("live signals pick the step the loop is on", () => {
  assert.deepEqual(liveStep("탐색", "chat: 구현 세션 2/3", ["implement-1.json", "gate-1.json"]), { step: "implement", detail: "구현 세션 2/3" });
  assert.deepEqual(liveStep("탐색", "chat: 구현 세션 2/3", ["implement-2.json"]), { step: "gate", detail: "검사 중 (세션 2/3)" });
  assert.deepEqual(liveStep("재구현", "settings: 검토 세션", []), { step: "review", detail: "Codex 검토 중" });
  assert.deepEqual(liveStep("PR 수정", "QA-0022: PR 수정 라운드 1, 세션 1/3", ["fix-1.json"]), { step: "checks", detail: "PR 수정 라운드 1 · 검사 중" });
  assert.deepEqual(liveStep("카드 작성", null, []), { step: "review", detail: "요약 카드 작성 중" });
});

test("progress shows checks, auto-merge and the live loop work", () => {
  const pr = { passed: 4, total: 6, failing: 0, codex: "pending" };
  const review = progressOf(ticket("pr-review"), { pr });
  assert.equal(current(review).key, "checks");
  assert.equal(review.detail, "CI 4/6 통과 · Codex 대기");
  assert.equal(review.ratio, 4 / 6);
  const merging = progressOf(ticket("final-review", { autoMerge: { at: "2026-10-19T06:00:00.000Z" } }), { pr });
  assert.equal(current(merging).key, "merge");
  assert.equal(merging.active, true);
  assert.equal(merging.detail, "CI 4/6 통과 · Codex 대기");
  const checking = progressOf(ticket("final-review", { autoMerge: { at: "x", checking: "2026-10-19T06:10:00.000Z" } }), { pr });
  assert.equal(checking.detail, "최신 main과 합쳐 lint·typecheck 확인 중");
  const held = progressOf(ticket("final-review", { autoMerge: { at: "x", held: "2026-10-19T06:20:00.000Z" } }), { pr });
  assert.equal(held.active, false);
  assert.match(held.detail, /머지 보류/);
  const live = progressOf(ticket("revising"), { live: { task: "재구현", line: "settings: 구현 세션 1/3", files: [], since: "s" } });
  assert.equal(live.active, true);
  assert.equal(live.detail, "구현 세션 1/3");
  assert.equal(current(progressOf(ticket("needs-human"))).state, "failed");
  assert.ok(progressOf(ticket("merged")).steps.every((s) => s.state === "done"));
  assert.equal(current(exploringOf({ screen: "chat", line: null, files: [], since: "s" }).progress).key, "found");
  const judging = exploringOf({ task: "판정", title: "지난달 매출 정리", line: "탐색: 판정 세션", files: [], since: "s" });
  assert.equal(judging.title, "지난달 매출 정리");
  assert.match(judging.progress.detail, /판정 세션/);
  const fixing = exploringOf({ task: "결함 수정", title: "F-0002 제목", screen: "usage", line: "usage: 구현 세션 2/3", files: [], since: "s" });
  assert.equal(fixing.area, "usage");
  assert.equal(fixing.progress.detail, "구현 세션 2/3");
  assert.equal(current(fixing.progress).key, "implement");
});

test("required checks not reported yet count as not passed", () => {
  const rollup = [
    { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "Vercel", state: "FAILURE" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
  ];
  const s = checksSummary(rollup, ["ci", "desktop"]);
  assert.equal(s.total, 2);
  assert.equal(s.passed, 1);
  assert.equal(s.pending, 1);
  assert.equal(checksSummary(rollup, []).failing, 1);
});

test("log lines keep their time", () => {
  assert.deepEqual(parseLine("[2026-10-19T05:53:51.937Z] QA-0028 pr-push 실패"), { at: "2026-10-19T05:53:51.937Z", text: "QA-0028 pr-push 실패" });
  assert.deepEqual(parseLine("{json}"), { at: null, text: "{json}" });
});

test("a ticket on the automatic route says so; one for the human keeps its reasons", () => {
  const auto = ticket("awaiting", { route: { auto: true, reasons: [], attempt: 1 } });
  assert.equal(stageOf(auto), "자동 진행 대기");
  assert.equal(progressOf(auto).detail, "watch가 곧 PR을 만듦");
  assert.deepEqual(cardOf(auto).route, { auto: true, reasons: [] });
  const human = ticket("awaiting", { route: { auto: false, reasons: ["시각 수정"], attempt: 1 } });
  assert.equal(stageOf(human), "승인 대기");
  assert.deepEqual(cardOf(human).route, { auto: false, reasons: ["시각 수정"] });
  assert.equal(cardOf(ticket("merged", { autoMerge: { at: "x", auto: true } })).autoMerged, true);
  assert.equal(cardOf(ticket("merged", { autoMerge: { at: "x" } })).autoMerged, false);
  assert.equal(cardOf(ticket("merged", { autoMerge: { at: "x", final: true } })).autoMerged, true);
  assert.equal(cardOf(ticket("awaiting")).route, null);
  const reached = ticket("final-review", { route: { auto: true, reasons: [] } });
  assert.equal(stageOf(reached), "자동 머지 중");
  assert.equal(progressOf(reached).detail, "자동 머지 기준 다시 확인 대기");
  assert.deepEqual(actionsOf(reached), []);
});

test("a card says which board it belongs to", () => {
  assert.equal(cardOf({ id: "QA-0001", title: "t", status: "awaiting" }).track, "fix");
  assert.equal(cardOf({ id: "QA-0002", title: "t", status: "awaiting", track: "improve", humanTouched: true }).track, "improve");
  assert.equal(cardOf({ id: "QA-0002", title: "t", status: "awaiting", humanTouched: true }).humanRevised, true);
  assert.equal(exploringOf({ task: "결함 수정", track: "improve", title: "F-0001 x" }).track, "improve");
  assert.equal(exploringOf({ task: "탐색" }).track, "fix");
});

test("the banner says when the recipe is being repaired, failed or waits for approval", async () => {
  const { alertsOf } = await import("../lib/view.mjs");
  const text = (recipe) => alertsOf([], [], false, null, recipe).map((a) => a.text);
  assert.match(text({ phase: "repair", stage: "session" })[0], /실행 지침 수리 중/);
  assert.match(text({ stage: "failed", error: "install 실패" })[0], /실행 지침 검증 실패.*fieldtest recipe repair/);
  assert.match(text({ awaitingApproval: ["checks"] })[0], /실행 지침 변경 승인 대기.*fieldtest recipe show/);
  assert.deepEqual(text({ phase: "repair", stage: "promoted" }), []);
});

test("the banner shows a loop that keeps failing, which Slack alone used to report", async () => {
  const { alertsOf } = await import("../lib/view.mjs");
  const text = (loop) => alertsOf([], [], false, null, {}, loop).map((a) => a.text);
  assert.match(text({ failures: 3, lastError: { message: "claude 종료 1\n상세" } })[0], /에이전트 루프 오류 3회 연속: claude 종료 1$/);
  assert.deepEqual(text({ failures: 2, lastError: { message: "x" } }), []);
});
