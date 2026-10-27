import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-proposal-"));
const { MONOREPO, useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe(MONOREPO);
const store = await import("../lib/store.mjs");
const { approve, revise } = await import("../lib/human.mjs");
const { proposalTicket, proposalsToday, specFeedback } = await import("../lib/agent.mjs");
const { nextOpenFinding } = await import("../lib/findings.mjs");
const { renderPrompt } = await import("../lib/engines.mjs");
const { routeOf } = await import("../lib/route.mjs");
const { actionsOf, cardOf, columnOf, stageOf } = await import("../lib/view.mjs");
const { commandHint, route } = await import("../lib/slack.mjs");

const proposal = (id, extra = {}) =>
  store.createTicket({
    id,
    status: "proposal",
    track: "propose",
    screen: "chat",
    title: "답변 표를 파일로 저장할 수 있게 한다",
    severity: "medium",
    kind: "functional",
    attempt: 0,
    implement: { engine: "claude", model: "m" },
    proposal: { version: 1, forbidden: [] },
    createdAt: new Date().toISOString(),
    ...extra,
  });

test("a proposal waits for the human on the 추가 board with approve, reject and revise", () => {
  const t = { id: "QA-0001", status: "proposal", track: "propose", title: "t", severity: "medium" };
  assert.equal(columnOf(t), "awaiting");
  assert.equal(stageOf(t), "제안 승인 대기");
  assert.deepEqual(actionsOf(t), ["approve", "reject", "revise"]);
  const card = cardOf(t);
  assert.equal(card.track, "improve");
  assert.equal(card.proposal, true);
  assert.equal(store.approvalWaiting([t]), 1);
});

test("Slack commands on a proposal approve, reject or revise it", () => {
  const t = { id: "QA-0001", status: "proposal" };
  assert.deepEqual(route(t, { verb: "승인", arg: "" }), { run: "approve" });
  assert.deepEqual(route(t, { verb: "거절", arg: "필요 없음" }), { run: "reject", arg: "필요 없음" });
  assert.deepEqual(route(t, { verb: "수정", arg: "범위 줄이기" }), { run: "revise", arg: "범위 줄이기" });
  assert.match(commandHint(t), /제안서를 읽고/);
});

test("approving a spec sends it to be built; one that needs forbidden paths goes to the human", async () => {
  proposal("QA-0002");
  assert.match(await approve("QA-0002"), /제안서대로 구현/);
  const built = store.readTicket("QA-0002");
  assert.equal(built.status, "revising");
  assert.equal(built.reviseFrom, "proposal");
  assert.equal(built.specApproved, true);

  proposal("QA-0003", { proposal: { version: 1, forbidden: ["apps/web/src/app/api/**"] } });
  assert.match(await approve("QA-0003"), /사람이 구현/);
  const human = store.readTicket("QA-0003");
  assert.equal(human.status, "needs-human");
  assert.match(human.needsHumanReason, /apps\/web\/src\/app\/api/);
});

test("수정 on a proposal rewrites the spec instead of building it", () => {
  proposal("QA-0004");
  revise("QA-0004", "첫 단계만 제안해 줘");
  const t = store.readTicket("QA-0004");
  assert.equal(t.status, "revising");
  assert.equal(t.reviseFrom, "proposal");
  assert.equal(t.specApproved, false);
});

test("proposals wait in the queue once the day's cap is used", () => {
  const findings = [
    { id: "F-0001", status: "open", severity: "medium", track: "propose" },
    { id: "F-0002", status: "open", severity: "medium", track: "fix" },
  ];
  assert.equal(nextOpenFinding(findings).id, "F-0001");
  assert.equal(nextOpenFinding(findings, { proposals: false }).id, "F-0002");
  const at = Date.parse("2026-10-26T12:00:00.000Z");
  const tickets = [
    { track: "propose", createdAt: "2026-10-26T01:00:00.000Z" },
    { track: "propose", createdAt: "2026-10-25T01:00:00.000Z" },
    { track: "fix", createdAt: "2026-10-26T01:00:00.000Z" },
  ];
  assert.equal(proposalsToday(tickets, at), 1);
});

test("a built proposal never takes the automatic route", () => {
  const route = routeOf({ status: "awaiting", track: "propose", kind: "functional", severity: "medium" }, "");
  assert.equal(route.auto, false);
  assert.deepEqual(route.reasons, ["기능 제안"]);
});

test("the spec becomes the ticket body and the implementer's mission", () => {
  const spec = "## 문제\n\n표를 복사해야 한다.\n\n## 완료 기준\n\n1. 저장을 누르면 파일이 받아진다.";
  const body = proposalTicket({ title: "표를 저장할 수 있게 한다", spec, forbidden: ["packages/**"] });
  assert.match(body, /^# 표를 저장할 수 있게 한다\n\n## 문제/);
  assert.match(body, /## 사람이 구현할 부분\n\n.*`packages\/\*\*`/);
  const mission = specFeedback(spec);
  assert.match(mission, /### 승인된 제안\n\n#### 문제/);
  assert.match(mission, /#### 완료 기준/);
});

test("the proposal prompt has every slot filled", () => {
  const p = renderPrompt("propose", {
    toolDir: "/t",
    demoUrl: "http://d",
    workDir: "/w",
    allowed: "a",
    forbidden: "f",
    maxFiles: 15,
    maxLines: 800,
    areas: "a",
    existing: "없음",
    finding: "### F-0001 [제안] t",
    feedback: "",
  });
  assert.match(p, /### F-0001 \[제안\] t/);
  assert.match(p, /테스트를 합쳐 15파일·800줄/);
  assert.doesNotMatch(p, /\{\{/);
});
