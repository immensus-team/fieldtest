import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-prompts-"));
const { MONOREPO, useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe(MONOREPO);
const { adviceOf, areasText, conditionsFor, findingHeadline, findingOf, findingText, implementVars, knownProblems, priorRounds, problemOnly, stepsText } = await import("../lib/agent.mjs");
const { createFinding } = await import("../lib/findings.mjs");
const { renderPrompt } = await import("../lib/engines.mjs");
const { REPRO_PASSES } = await import("../lib/config.mjs");
const { createTicket } = await import("../lib/store.mjs");
const { loadScreens } = await import("../lib/screens.mjs");

const screen = loadScreens().find((s) => s.id === "usage");
createTicket({ id: "QA-0001", screen: "usage", status: "revising", title: "고치는 중인 티켓", attempt: 1 });
createTicket({ id: "QA-0002", screen: "usage", status: "awaiting", title: "다른 티켓", attempt: 1 });
createTicket({ id: "QA-0003", screen: "chat", status: "rejected", title: "다른 화면의 거절된 티켓", rejectReason: "의도된 동작", attempt: 1 });
createTicket({ id: "QA-0004", screen: "files", status: "merged", title: "다른 화면의 끝난 티켓", attempt: 1 });

test("the first explore prompt has no undefined and lists the screen's tickets", () => {
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s" }));
  assert.doesNotMatch(p, /undefined/);
  assert.doesNotMatch(p, /\{\{(?!SCREENSHOTS)\w+\}\}/);
  assert.match(p, /QA-0001 \[revising\]/);
  assert.match(p, new RegExp(`재현 테스트를 ${REPRO_PASSES}번 연속, 재시도 없이`));
});

test("a revise prompt puts its section right after the mission and leaves out its own ticket", () => {
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s", feedback: "## 이번 작업: 재구현", excludeTicket: "QA-0001" }));
  const at = (s) => p.indexOf(s);
  assert.ok(at(screen.mission) < at("## 이번 작업: 재구현"));
  assert.match(p, /## 고칠 결함\n\n아래 "이번 작업" 절의 문제다\.\n\n## 이번 작업: 재구현/);
  assert.ok(at("## 이번 작업: 재구현") < at("## 데모 앱"));
  assert.ok(at("## 이번 작업: 재구현") < at("## 순서"));
  assert.doesNotMatch(p, /QA-0001/);
  assert.match(p, /QA-0002 \[awaiting\]/);
});

test("prompts carry the inline style rules and no reference to personal instructions", () => {
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s" }));
  assert.match(p, /### 한국어 문체/);
  assert.match(p, /feature flag에 관한 규칙/);
  // The repo's small-UI rule reaches every run: no new test only for a behavior-neutral UI fix.
  assert.match(p, /동작을 바꾸지 않는 작은 UI 수정에는 그 수정만을 위한 새 테스트를 추가하지\n않는다/);
  assert.doesNotMatch(p, /전역 지침/);
});

test("problemOnly keeps the needs-human reason and drops the earlier fix", () => {
  const md = "# 제목\n\n## 요약\n고쳤다\n\n## 재현 절차\n1. 연다\n\n## 수정\n바꿨다\n\n## 사람 판단이 필요한 이유\n\nspec이 틀렸다\n";
  const out = problemOnly(md);
  assert.match(out, /## 재현 절차/);
  assert.match(out, /## 사람 판단이 필요한 이유\n\nspec이 틀렸다/);
  assert.doesNotMatch(out, /## 수정|## 요약/);
});

// Shape of a Codex inline review comment.
const BODY = "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Keep the draft cancel control off the download button**\n\nWhen a ready upload remains attached…";

test("a Codex finding's first line becomes a short headline", () => {
  assert.equal(findingHeadline(BODY), "[P2] Keep the draft cancel control off the download button");
  assert.equal(findingHeadline("\n\nPlain title\nmore"), "Plain title");
});

test("earlier PR rounds are listed with how each finding was handled", () => {
  const tdir = mkdtempSync(join(tmpdir(), "uq-rounds-"));
  const r1 = join(tdir, "pr-rounds", "1");
  mkdirSync(r1, { recursive: true });
  writeFileSync(join(r1, "request.json"), JSON.stringify({ humanFeedback: "Y축 글자 크기를 맞춘다\n자세히", findings: [{ id: 7, path: "a.tsx", body: BODY }], ciFailures: [{ name: "e2e" }] }));
  writeFileSync(join(r1, "result.json"), JSON.stringify({ comments: [{ commentId: 7, action: "fixed" }] }));
  const out = priorRounds(tdir, 2);
  assert.match(out, /라운드 1 사람 피드백: Y축 글자 크기를 맞춘다$/m);
  assert.match(out, /라운드 1 CI 실패: e2e/);
  assert.match(out, /라운드 1 `a.tsx`: \[P2\] Keep the draft cancel control off the download button → fixed/);
  assert.equal(priorRounds(tdir, 1), "없음");
});

test("review and PR-fix prompts render with every slot filled", () => {
  const review = renderPrompt("review", { toolDir: "/t", demoUrl: "d", shotsDir: "/s", ticket: "t", gate: "g", changedTestsReason: "없음", diffFile: "/d" });
  assert.match(review, /7\. `kind`가 결함 종류 기준과 맞는지 본다/);
  assert.match(review, /재현 테스트가 결함과 다른 이유로 base에서 실패함/);
  const fix = renderPrompt("pr-fix", { allowed: "a", forbidden: "f", toolDir: "/t", demoUrl: "d", specs: "s", shotsDir: "/s", request: "r", history: "- 라운드 1 …", ticket: "t" });
  assert.match(fix, /## 이전 라운드 지적\n\n- 라운드 1 …/);
  assert.match(fix, /`prBodyGaps`/);
  assert.match(fix, /세 번째면 방어 코드를 더하지 않는다/);
  assert.doesNotMatch(fix, /고친 종류가 다시 지적되면/);
  for (const p of [review, fix]) assert.doesNotMatch(p, /undefined|\{\{\w+\}\}/);
  assert.ok(!readFileSync(new URL("../prompts/ticket-style.md", import.meta.url), "utf8").includes("전역 지침"));
});

test("other screens' open or rejected tickets are listed too, finished ones are not", () => {
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s" }));
  assert.match(p, /### 이 화면\n\n- QA-0001 \[revising\]/);
  assert.match(p, /### 다른 화면 \(열려 있거나 거절된 것\)\n\n- QA-0003 \[chat, rejected\] 다른 화면의 거절된 티켓\n  거절 사유: 의도된 동작/);
  assert.doesNotMatch(p, /QA-0004/);
});

const { reviewLines } = await import("../lib/gate.mjs");
const { withReviewResult } = await import("../lib/publish.mjs");

test("the local review's minor findings and unchecked scope reach the ticket and the PR body", () => {
  const review = { verdict: "pass", findings: [{ severity: "minor", title: "라벨 색이 조금 연하다" }], notChecked: "Safari는 보지 않았다." };
  assert.equal(reviewLines(review), "- 판정: 통과\n- 사소한 지적:\n  - 라벨 색이 조금 연하다\n- 확인하지 못한 범위: Safari는 보지 않았다.");
  assert.match(reviewLines({ verdict: "pass", findings: [], notChecked: "" }), /사소한 지적: 없음\n- 확인하지 못한 범위: 없음/);
  const body = withReviewResult("## Test\n", review);
  assert.match(body, /<!-- quality:review -->\n### 로컬 검토 \(Codex\)\n\n- 판정: 통과/);
  assert.equal(withReviewResult("x", null), "x");
});

test("the reviewer's suggested fixes become one direction for 수정", () => {
  assert.equal(adviceOf([]), null);
  assert.equal(adviceOf([{ title: "a", fix: " 길이로 계산한다 " }]), "길이로 계산한다");
  assert.equal(adviceOf([{ title: "a", fix: "x" }, { title: "b", fix: "y" }, { title: "c", fix: "" }]), "- a: x\n- b: y");
});

const VARS = { toolDir: "/t", demoUrl: "http://d", workDir: "/w", conditions: "- 화면 폭: 390px", areas: "a" };

test("a finding fix prompt carries the finding, the area and the preloaded demo data", () => {
  createFinding({ session: "1", steps: [3], area: "usage", severity: "medium", kind: "functional", title: "기간을 바꾸면 표가 비어 있다", repro: "1. 연다", expected: "보인다", actual: "비었다", evidence: "judge-3.png" });
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s", mission: findingText({ id: "F-0001", session: "1", severity: "medium", kind: "functional", title: "기간을 바꾸면 표가 비어 있다", repro: "1. 연다", expected: "보인다", actual: "비었다", evidence: "judge-3.png" }) }));
  assert.match(p, /## 고칠 결함\n\n### F-0001 기간을 바꾸면 표가 비어 있다/);
  assert.match(p, /#### 재현 절차\n\n1\. 연다/);
  assert.ok(p.indexOf(screen.mission) < p.indexOf("## 고칠 결함"));
  assert.match(p, /- 로그인: 로그인이 필요 없다\./);
  assert.doesNotMatch(p, /undefined|\{\{(?!SCREENSHOTS)\w+\}\}/);
});

test("use and judge prompts render with every slot filled", () => {
  const use = renderPrompt("use", { ...VARS, recentGoals: "- 지난주 매출 정리" });
  assert.match(use, /행동하기 \*\*전에\*\* 그 행동의 기대 결과를 한 줄로 정한다/);
  assert.match(use, /## 최근 목표\n\n- 지난주 매출 정리/);
  const steps = stepsText([{ n: 1, area: "chat", url: "u", probe: true, action: "두 번 누른다", expected: "한 번 보낸다", actual: "두 번 보냈다", matched: false, screenshot: "step-1.png" }]);
  assert.equal(steps, "1. [기대와 다름, 찔러 보기] chat u\n   - 행동: 두 번 누른다\n   - 기대: 한 번 보낸다\n   - 실제: 두 번 보냈다\n   - 스크린샷: step-1.png");
  const judge = renderPrompt("judge", { ...VARS, useShots: "/w/shots", existing: knownProblems(), conditions: "390px", persona: "p", goal: "g", summary: "s", steps });
  assert.match(judge, /`not-reproduced`/);
  assert.match(judge, /### 고치기 전인 발견\n\n- F-0001 \[usage\] 기간을 바꾸면 표가 비어 있다/);
  for (const p of [use, judge]) assert.doesNotMatch(p, /undefined|\{\{\w+\}\}/);
});

test("the judge hears of open and rejected tickets, not merged ones", () => {
  const known = knownProblems();
  assert.match(known, /QA-0003 \[chat, rejected\] 다른 화면의 거절된 티켓\n  거절 사유: 의도된 동작/);
  assert.doesNotMatch(known, /QA-0004/);
});

test("explorations go through every journey in both themes at desktop width", () => {
  const journeys = ["주문 받기", "재고 정리", "보고서 보기"];
  const all = Array.from({ length: journeys.length * 2 }, (_, n) => conditionsFor(n, journeys));
  assert.equal(new Set(all.map((c) => `${c.journey}|${c.theme}`)).size, journeys.length * 2);
  assert.ok(all.every((c) => c.width === 1440 && c.input === "마우스와 키보드"));
});

test("a judgment opens a finding only at medium severity or above", () => {
  const steps = [{ n: 1, area: "chat" }];
  const finding = { area: "", severity: "medium", kind: "functional", title: "t", repro: "r", expected: "e", actual: "a", evidence: "v" };
  const judge = (verdict, severity) => findingOf({ steps: [1], verdict, reason: "x", finding: { ...finding, severity } }, steps, ["chat"]);
  assert.equal(judge("defect", "medium").track, "fix");
  assert.equal(judge("defect", "medium").area, "chat");
  assert.equal(judge("improvement", "medium").track, "improve");
  assert.equal(judge("proposal", "medium").track, "propose");
  assert.equal(judge("defect", "low"), null);
  assert.equal(judge("trivial", "none"), null);
});

test("the area map lists every area with its start URL", () => {
  const text = areasText();
  for (const s of loadScreens()) assert.match(text, new RegExp(`### ${s.id}\n\n시작 주소: \`${s.url.replace(/[?]/g, "\\?")}\``));
  assert.doesNotMatch(text, /사용자 여정/);
});

test("friction on a step that went as expected reaches the judge, and an improvement carries its own rules", () => {
  const steps = stepsText([{ n: 2, area: "files", url: "u", probe: false, action: "폴더를 만든다", expected: "만들어진다", actual: "만들어졌다", matched: true, friction: "새 폴더 버튼을 메뉴 두 단계 아래에서 찾았다", screenshot: "step-2.png" }]);
  assert.equal(steps, "2. [기대대로, 마찰] files u\n   - 행동: 폴더를 만든다\n   - 기대: 만들어진다\n   - 실제: 만들어졌다\n   - 마찰: 새 폴더 버튼을 메뉴 두 단계 아래에서 찾았다\n   - 스크린샷: step-2.png");
  const judge = renderPrompt("judge", { ...VARS, useShots: "/w/shots", existing: "없음", conditions: "390px", persona: "p", goal: "g", summary: "s", steps });
  assert.match(judge, /`improvement`: 결함은 아니지만 기존 흐름의 마찰이고/);
  assert.match(judge, /`proposal`: 이 업무 여정을 끝내려면/);
  const f = { id: "F-0009", session: "1", severity: "low", kind: "functional", title: "새 폴더 버튼을 찾기 어렵다", repro: "1. 연다", expected: "바로 보인다", actual: "메뉴 안에 있다", evidence: "step-2.png" };
  assert.doesNotMatch(findingText(f), /이 항목은 개선이다/);
  const improve = findingText({ ...f, track: "improve" });
  assert.match(improve, /^### F-0009 \[개선\] 새 폴더 버튼을 찾기 어렵다/);
  assert.match(improve, /#### 이 항목은 개선이다/);
});

test("the bootstrap prompt renders with every slot filled", () => {
  const p = renderPrompt("bootstrap", { toolDir: "/t", draftDir: "/d", demoUrl: "http://d", workDir: "/w", guideDocs: "AGENTS.md", mode: "처음 만들기", repo: "acme/shop", baseBranch: "main", feedback: "", secrets: "없음", declined: "없음" });
  assert.doesNotMatch(p, /undefined|\{\{\w+\}\}/);
  assert.match(p, /실행 지침 초안은 `\/d`에 쓴다/);
  assert.match(p, /"autoRoute": null/);
});

test("the implement session leaves the runner's checks to the runner in the PR body", async () => {
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s" }));
  const { currentRecipe } = await import("../lib/recipe.mjs");
  const names = currentRecipe().checks.map((c) => c.name).join(", ");
  assert.ok(p.includes(`실행기가 PR을 열기 전에 돌리는 검사: ${names}.`));
  assert.match(p, /돌리지 않았다고 쓰지 않는다/);
});
