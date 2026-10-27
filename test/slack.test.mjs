import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-slack-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { asksHuman, buttonsFor, commandHint, commandModal, parentBlocks, parseCommand, route, routeLine, slackToPlain, statusNote } = await import("../lib/slack.mjs");
const { STATUSES } = await import("../lib/store.mjs");

test("commands parse with or without a ticket id and a colon", () => {
  assert.deepEqual(parseCommand("승인"), { id: null, verb: "승인", arg: "" });
  assert.deepEqual(parseCommand("  거절: 이미 #301에서 고쳤다 "), { id: null, verb: "거절", arg: "이미 #301에서 고쳤다" });
  assert.deepEqual(parseCommand("qa-0003 수정 포커스를 버튼으로\n돌려 놓는다"), { id: "QA-0003", verb: "수정", arg: "포커스를 버튼으로\n돌려 놓는다" });
  assert.deepEqual(parseCommand("진행"), { id: null, verb: "승인", arg: "" });
  assert.equal(parseCommand("이거 승인해도 돼?"), null);
  assert.equal(parseCommand("승인해"), null);
});

test("Slack escapes and links become plain text", () => {
  assert.equal(slackToPlain("수정 &lt;Chart&gt;에서 <https://github.com/x/y/pull/1|PR> 참고 &amp; 확인"), "수정 <Chart>에서 https://github.com/x/y/pull/1 참고 & 확인");
});

test("each command maps to the CLI action for the ticket's status", () => {
  const at = (status) => ({ id: "QA-0001", status, pr: { number: 1, url: "u", round: 0 } });
  assert.deepEqual(route(at("awaiting"), { verb: "승인", arg: "" }), { run: "approve" });
  assert.deepEqual(route(at("awaiting"), { verb: "수정", arg: "x" }), { run: "revise", arg: "x" });
  assert.deepEqual(route(at("needs-human"), { verb: "수정", arg: "x" }), { run: "revise", arg: "x" });
  assert.deepEqual(route(at("final-review"), { verb: "수정", arg: "x" }), { run: "feedback", arg: "x" });
  assert.deepEqual(route(at("needs-human"), { verb: "거절", arg: "중복" }), { run: "reject", arg: "중복" });
  assert.match(route(at("needs-human"), { verb: "승인", arg: "" }).error, /후보가 없습니다/);
  assert.match(route(at("awaiting"), { verb: "거절", arg: "" }).error, /이유/);
  assert.match(route(at("final-review"), { verb: "수정", arg: "" }).error, /내용/);
  assert.deepEqual(route(at("final-review"), { verb: "거절", arg: "x" }), { run: "reject", arg: "x" });
  assert.match(route(at("pr-review"), { verb: "수정", arg: "x" }).error, /진행 중/);
});

test("the message shows the title large, details small, then the summary, buttons and a hint", () => {
  const t = { id: "QA-0005", title: "X축 <30·31> 겹침", status: "awaiting", screen: "usage", severity: "medium", attempt: 1 };
  const blocks = parentBlocks(t, { summary: "날짜가 겹칩니다. `30`을 숨겼습니다." });
  assert.deepEqual(blocks.map((b) => b.type), ["header", "context", "section", "actions", "context", "divider"]);
  assert.equal(blocks[0].text.text, "X축 <30·31> 겹침");
  const meta = blocks[1].elements[0].text;
  assert.match(meta, /\*QA-0005\*/);
  assert.match(meta, /🟡 medium/);
  assert.match(meta, /\*승인 대기\*/);
  assert.doesNotMatch(meta, /usage/);
  assert.equal(blocks[2].text.text, "📌 날짜가 겹칩니다. `30`을 숨겼습니다.");
  assert.match(blocks[4].elements[0].text, /`진행`/);
  const judged = parentBlocks({ ...t, status: "needs-human", severity: "high", needsHumanReason: "spec이 틀렸다\n자세히" });
  assert.match(judged[1].elements[0].text, /🔴 high/);
  assert.equal(judged.find((b) => b.block_id === "why").text.text, "> ⚠️ spec이 틀렸다");
  assert.ok(!judged.some((b) => b.block_id === "summary"));
});

test("every status has a hint and a known note", () => {
  for (const s of STATUSES) {
    assert.ok(commandHint({ status: s }), s);
    const note = statusNote({ status: s, pr: { number: 1, url: "u", round: 0 }, needsHumanReason: "r" });
    if (s === "pr-push") assert.equal(note, null);
    else assert.ok(note.text, s);
  }
  assert.equal(statusNote({ status: "final-review", severity: "high", pr: { number: 1, url: "u", round: 0 } }).broadcast, true);
  assert.equal(statusNote({ status: "pr-review", pr: { number: 1, url: "u", round: 0 } }).broadcast, undefined);
});

test("buttons follow the ticket's status and 진행 asks for confirmation", () => {
  const t = { id: "QA-0002", title: "t", status: "awaiting", screen: "chat", attempt: 1 };
  assert.deepEqual(buttonsFor(t), ["approve", "reject", "revise"]);
  assert.deepEqual(buttonsFor({ ...t, status: "needs-human" }), ["reject", "revise"]);
  assert.deepEqual(buttonsFor({ ...t, status: "final-review", severity: "high" }), ["merge", "revise", "reject"]);
  assert.deepEqual(buttonsFor({ ...t, status: "final-review", severity: "low" }), []);
  assert.deepEqual(buttonsFor({ ...t, reviseAdvice: "길이로 계산" }), ["approve", "reject", "revise", "adopt"]);
  assert.deepEqual(buttonsFor({ ...t, status: "final-review", autoMerge: { at: "x" } }), []);
  assert.ok(parentBlocks({ ...t, status: "final-review", autoMerge: { at: "x" } }).some((b) => b.block_id === "merging"));
  assert.deepEqual(buttonsFor({ ...t, status: "pr-review" }), []);
  const actions = parentBlocks(t).find((b) => b.type === "actions");
  assert.deepEqual(actions.elements.map((e) => [e.action_id, e.text.text, e.value]), [["approve", "진행", "QA-0002"], ["reject", "거절", "QA-0002"], ["revise", "수정", "QA-0002"]]);
  assert.equal(actions.elements[0].confirm.text.text, "이 수정으로 PR을 만들고 CI와 Codex 리뷰를 진행합니다.");
  assert.ok(!parentBlocks({ ...t, status: "pr-review" }).some((b) => b.type === "actions"));
  const pending = parentBlocks(t, { pending: "진행" });
  assert.equal(pending.at(-2).block_id, "pending");
  assert.ok(!pending.some((b) => b.type === "actions"));
});

test("the input box asks for a reason or a requirement and carries the ticket", () => {
  const t = { id: "QA-0002", title: "t", status: "awaiting" };
  const where = { channel: "D1", ts: "1.2" };
  const label = (v) => v.blocks.find((b) => b.type === "input").label.text;
  assert.equal(label(commandModal(t, "거절", where)), "거절 이유");
  assert.equal(label(commandModal(t, "수정", where)), "새 요구사항");
  assert.equal(label(commandModal({ ...t, status: "final-review" }, "수정", where)), "PR에서 고칠 점");
  const prefilled = commandModal({ ...t, reviseAdvice: "길이로 계산" }, "수정", where).blocks.find((b) => b.block_id === "arg");
  assert.equal(prefilled.element.initial_value, "길이로 계산");
  assert.equal(commandModal({ ...t, reviseAdvice: "길이로 계산" }, "거절", where).blocks.find((b) => b.block_id === "arg").element.initial_value, undefined);
  assert.deepEqual(JSON.parse(commandModal(t, "수정", where).private_metadata), { id: "QA-0002", verb: "수정", channel: "D1", ts: "1.2" });
  assert.ok(commandModal(t, "수정", where).title.text.length <= 24);
  const fromNote = JSON.parse(commandModal(t, "수정", { ...where, ts: "1.5", thread: "1.2", noteText: "✅ 머지 준비" }).private_metadata);
  assert.deepEqual(fromNote, { id: "QA-0002", verb: "수정", channel: "D1", ts: "1.5", thread: "1.2", noteText: "✅ 머지 준비" });
});

test("a failed revise is announced as a failure, not as a new candidate", () => {
  const t = { id: "QA-0002", title: "t", status: "awaiting", screen: "chat", attempt: 1, reviseNote: "게이트 실패: pnpm test\n자세히" };
  const note = statusNote(t);
  assert.equal(note.text, "재구현 실패: 게이트 실패: pnpm test\n이전 후보로 돌아왔습니다. `진행`을 누르면 이전 후보로 PR을 만듭니다.");
  const reviewed = statusNote({ ...t, reviseNote: "검토자가 후보를 통과시키지 않음\n- 설정에서 돌아오면 안내가 사라짐\n  조건: 붙여 넣고 설정을 연다\n- 이모지 경계에서 안내가 없음" });
  assert.equal(reviewed.text, "재구현 실패: 검토자가 후보를 통과시키지 않음: 설정에서 돌아오면 안내가 사라짐 / 이모지 경계에서 안내가 없음\n이전 후보로 돌아왔습니다. `진행`을 누르면 이전 후보로 PR을 만듭니다.");
  assert.equal(statusNote({ ...t, status: "needs-human", reviseNote: "x" }).text, "재구현 실패: x\n이전 상태로 돌아왔습니다.");
  assert.equal(note.broadcast, true);
  assert.equal(parentBlocks(t).find((b) => b.block_id === "why").text.text, "> ⚠️ 재구현 실패: 게이트 실패: pnpm test");
  assert.match(statusNote({ ...t, reviseNote: null }).text, /새 후보/);
});

test("next steps read as polite sentences and code results as short notes", () => {
  const pr = { number: 3, url: "u", round: 0 };
  assert.equal(statusNote({ status: "pr-review", pr }).text, "<u|PR #3> Codex 리뷰와 CI를 기다립니다.");
  assert.equal(
    statusNote({ status: "final-review", pr, prNote: "main과 충돌함." }).text,
    "⚠️ <u|PR #3> 자동 처리가 끝났지만 남은 문제가 있습니다.\n남은 문제: main과 충돌함.\nPR을 확인하고 merge하거나 `수정`으로 고칠 점을 보내면 됩니다. merge하지 않고 닫으려면 `거절`을 보내면 됩니다.",
  );
  assert.equal(
    statusNote({ status: "final-review", severity: "high", pr }).text,
    "✅ <u|PR #3> 머지 준비가 완료되었습니다. CI와 Codex 리뷰를 모두 통과했습니다.\nPR을 확인하고 `머지`를 누르면 squash merge합니다. 고칠 점은 `수정`으로 보내면 됩니다.",
  );
  assert.equal(statusNote({ status: "final-review", pr, prNote: "x" }).broadcast, true);
  const fixedDuringMerge = statusNote({ status: "final-review", pr, autoMerge: { at: "x" } });
  assert.equal(fixedDuringMerge.text, "🔧 <u|PR #3> 수정을 마쳤고 CI와 Codex 리뷰를 통과했습니다. 이어서 merge합니다.");
  assert.equal(fixedDuringMerge.buttons, undefined);
  assert.equal(statusNote({ status: "final-review", severity: "low", pr }).text, "🤖 <u|PR #3> CI와 Codex 리뷰를 통과했습니다. 심각도가 high가 아니라 최종 검토 없이 이어서 merge합니다.");
  assert.equal(statusNote({ status: "merged", pr, autoMerge: { at: "x", final: true } }).text, "🤖 <u|PR #3> 최종 검토 없이 자동 merge했습니다. 티켓을 종료합니다.");
  assert.equal(statusNote({ status: "merged", pr }).text, "merge됐습니다. 티켓을 종료합니다.");
  const blocked = statusNote({ status: "awaiting", reviseNote: "검토자가 후보를 통과시키지 않았다\n- 안내가 사라짐", reviseAdvice: "안내를 입력 길이에서 계산" });
  assert.match(blocked.text, /`진행`을 누르면 이전 후보로 PR을 만듭니다/);
  assert.match(blocked.text, /\*추천 수정 방향\*\n안내를 입력 길이에서 계산/);
  assert.deepEqual(blocked.buttons, ["adopt", "revise"]);
  assert.equal(statusNote({ status: "awaiting", reviseNote: "x" }).buttons, undefined);
  assert.match(statusNote({ status: "grouped", groupId: "QA-0020" }).text, /QA-0020에서 함께 고칩니다/);
  assert.match(statusNote({ status: "grouping", group: { members: ["a", "b", "c", "d"] } }).text, /4건으로 묶음을 다시/);
  assert.equal(
    statusNote({ status: "merged", resolvedBy: { number: 9, url: "v" } }).text,
    "<v|PR #9>에서 함께 해결했습니다. 티켓을 종료합니다.",
  );
  const pending = parentBlocks({ id: "QA-0002", title: "t", status: "awaiting" }, { pending: "진행" });
  assert.equal(pending.find((b) => b.block_id === "pending").elements[0].text, "⏳ 진행 요청을 받았습니다. 곧 처리합니다.");
});

test("a long log keeps its end, split into code blocks Slack won't split again", async () => {
  const { logBlocks } = await import("../lib/slack.mjs");
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} <x>`);
  const blocks = logBlocks(`${lines.join("\n")}\nfailed here\n`);
  assert.equal(blocks.length, 3);
  for (const b of blocks) {
    assert.ok(b.length < 4000);
    assert.ok(b.startsWith("```\n") && b.endsWith("\n```"));
  }
  assert.ok(blocks[0].startsWith("```\n…\nline "), "starts at a whole line after the cut");
  assert.ok(blocks[2].endsWith("line 1999 &lt;x&gt;\nfailed here\n```"));
  assert.deepEqual(logBlocks("short"), ["```\nshort\n```"]);
});

test("a log with no line breaks is never cut inside an escape", async () => {
  const { logBlocks } = await import("../lib/slack.mjs");
  for (const pad of [0, 1, 2, 3]) {
    const blocks = logBlocks(`${"x".repeat(pad)}${"a<".repeat(5000)}`);
    for (const b of blocks) assert.doesNotMatch(b.replace(/^```\n(…\n)?/, ""), /^(lt;|t;|;|gt;)/);
  }
});

test("머지 runs only on a final-review ticket and the ready note carries the button", () => {
  assert.deepEqual(parseCommand("머지"), { id: null, verb: "머지", arg: "" });
  const pr = { number: 3, url: "u", round: 0 };
  assert.deepEqual(route({ id: "QA-1", status: "final-review", pr }, { verb: "머지", arg: "" }), { run: "merge" });
  assert.match(route({ id: "QA-1", status: "pr-review", pr }, { verb: "머지", arg: "" }).error, /최종 검토 중인 PR에만/);
  assert.match(route({ id: "QA-1", status: "awaiting" }, { verb: "머지", arg: "" }).error, /최종 검토 중인 PR에만/);
  assert.deepEqual(statusNote({ status: "final-review", severity: "high", pr }).buttons, ["merge", "revise", "reject"]);
  assert.equal(statusNote({ status: "final-review", pr, prNote: "x" }).buttons, undefined);
  assert.equal(statusNote({ status: "merged", pr }).broadcast, true);
  const merge = parentBlocks({ id: "QA-1", title: "t", status: "final-review", severity: "high", pr }).find((b) => b.type === "actions").elements[0];
  assert.equal(merge.action_id, "merge");
  assert.match(merge.confirm.text.text, /squash merge합니다/);
});

test("the automatic route shows on the message and its merge is announced", () => {
  const t = { id: "QA-0099", title: "t", status: "pr-review", severity: "low", attempt: 1, route: { auto: true, reasons: [] }, pr: { number: 9, url: "u", round: 0 } };
  const line = parentBlocks(t).find((b) => b.block_id === "route");
  assert.match(line.elements[0].text, /^🤖 자동 진행/);
  const merging = { ...t, status: "final-review", autoMerge: { at: "x", auto: true } };
  assert.ok(!parentBlocks(merging).some((b) => b.block_id === "merging"), "one line about the route, not two");
  assert.match(statusNote(merging).text, /자동 머지 기준을 다시 확인하고 이어서 merge/);
  const reached = { ...t, status: "final-review", prNote: null };
  assert.match(statusNote(reached).text, /^🤖/);
  assert.equal(statusNote(reached).buttons, undefined, "no 머지 button while watch merges it");
  assert.deepEqual(buttonsFor(reached), []);
  assert.deepEqual(buttonsFor({ ...reached, prNote: "push 거부" }), ["merge", "revise", "reject"]);
  const merged = { ...merging, status: "merged" };
  assert.match(statusNote(merged).text, /사람 확인 없이 자동 merge했습니다/);
  assert.equal(statusNote(merged).broadcast, true);
  assert.match(routeLine(merged), /사람 확인 없이 merge했습니다/);
  const human = { ...t, status: "awaiting", route: { auto: false, reasons: ["시각 수정", "화면 문구 변경 (a.tsx)"] } };
  assert.equal(routeLine(human), "👤 사람 확인 이유: 시각 수정, 화면 문구 변경 (a.tsx)");
  assert.equal(routeLine({ ...human, status: "pr-review" }), null);
  assert.equal(routeLine({ ...t, route: undefined }), null);
});

test("Slack hears only of what the human must act on", () => {
  const pr = { number: 3, url: "u", round: 0 };
  // An awaiting candidate counts once watch has judged its route for this attempt.
  assert.equal(asksHuman({ status: "awaiting", attempt: 1 }), false);
  assert.equal(asksHuman({ status: "awaiting", attempt: 1, route: { auto: true, attempt: 1 } }), false);
  assert.equal(asksHuman({ status: "awaiting", attempt: 2, route: { auto: false, attempt: 1 } }), false);
  assert.equal(asksHuman({ status: "awaiting", attempt: 1, route: { auto: false, attempt: 1 } }), true);
  assert.equal(asksHuman({ status: "needs-human" }), true);
  assert.equal(asksHuman({ status: "pr-review", pr }), false);
  assert.equal(asksHuman({ status: "final-review", severity: "low", pr }), false);
  assert.equal(asksHuman({ status: "final-review", severity: "high", pr }), true);
  assert.equal(asksHuman({ status: "merged", pr, autoMerge: { auto: true } }), false);
  const ask = (t) => Boolean(statusNote(t)?.ask);
  assert.equal(ask({ status: "awaiting" }), true);
  assert.equal(ask({ status: "needs-human", needsHumanReason: "r" }), true);
  assert.equal(ask({ status: "final-review", severity: "high", pr }), true);
  assert.equal(ask({ status: "final-review", pr, prNote: "main과 충돌함." }), true);
  for (const t of [
    { status: "revising" },
    { status: "pr-review", pr },
    { status: "pr-fixing", pr },
    { status: "final-review", severity: "low", pr },
    { status: "merged", pr },
    { status: "merged", pr, autoMerge: { auto: true } },
    { status: "rejected" },
    { status: "grouped", groupId: "QA-0020" },
  ])
    assert.equal(ask(t), false, t.status);
});
