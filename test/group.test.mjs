import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-group-"));
const { MONOREPO, useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe(MONOREPO);
const { applyGroupPlan, closeMembers, groupPlan, knownCauses, releaseMembers, ticketScreen } = await import("../lib/group.mjs");
const { createTicket, listTickets, readTicket, ticketDir } = await import("../lib/store.mjs");
const { groupFeedback, implementVars } = await import("../lib/agent.mjs");
const { renderPrompt } = await import("../lib/engines.mjs");
const { loadScreens } = await import("../lib/screens.mjs");

const focus = { key: "focus-not-returned", summary: "닫히거나 사라진 컨트롤에서 포커스가 빠짐" };
const single = (id, extra) => createTicket({ id, screen: "files", status: "awaiting", title: id, severity: "low", attempt: 1, implement: { engine: "claude", model: null }, ...extra });

test("two tickets of a cause wait; the third starts a group", () => {
  single("QA-0001", { cause: focus });
  single("QA-0002", { cause: focus, status: "needs-human", screen: "chat" });
  single("QA-0003", { cause: { key: "flex-text-overflow", summary: "긴 글자가 넘침" } });
  single("QA-0004");
  assert.equal(groupPlan(listTickets()), null);
  single("QA-0005", { cause: focus, severity: "medium" });
  assert.deepEqual(groupPlan(listTickets()), { cause: focus, members: ["QA-0001", "QA-0002", "QA-0005"] });
});

test("starting a group takes the tickets over and names the cause for later tickets", () => {
  const out = applyGroupPlan(listTickets(), groupPlan(listTickets()));
  assert.deepEqual(out, { result: "group", ticket: "QA-0006", members: ["QA-0001", "QA-0002", "QA-0005"] });
  const group = readTicket("QA-0006");
  assert.equal(group.status, "grouping");
  assert.equal(group.severity, "medium");
  assert.deepEqual(group.group.members, ["QA-0001", "QA-0002", "QA-0005"]);
  assert.equal(readTicket("QA-0002").status, "grouped");
  assert.equal(readTicket("QA-0002").groupFrom, "needs-human");
  assert.match(knownCauses(listTickets()), /`focus-not-returned`: 닫히거나/);
  // A group being built does not take in new tickets, and no second group starts beside it.
  single("QA-0007", { cause: focus });
  assert.equal(groupPlan(listTickets()), null);
});

test("a group waiting for the human takes in a new ticket of its cause and is built again", () => {
  const group = readTicket("QA-0006");
  createTicket({ ...group, status: "awaiting" });
  const plan = groupPlan(listTickets());
  assert.deepEqual(plan, { join: "QA-0006", members: ["QA-0007"] });
  applyGroupPlan(listTickets(), plan);
  assert.equal(readTicket("QA-0006").status, "grouping");
  assert.deepEqual(readTicket("QA-0006").group.members, ["QA-0001", "QA-0002", "QA-0005", "QA-0007"]);
  assert.equal(readTicket("QA-0007").groupId, "QA-0006");
});

test("the group spans its tickets' screens and every shared web path", () => {
  const screen = ticketScreen(readTicket("QA-0006"), loadScreens());
  assert.ok(screen.paths.includes("apps/web/src/components/**"));
  const chat = loadScreens().find((s) => s.id === "chat");
  for (const spec of chat.specs) assert.ok(screen.specs.includes(spec));
});

test("the group prompt lists the tickets and asks for the other places of the cause", () => {
  for (const id of ["QA-0001", "QA-0002"]) {
    mkdirSync(ticketDir(id), { recursive: true });
    writeFileSync(join(ticketDir(id), "ticket.md"), `# ${id} 제목\n\n## 재현 절차\n1. 연다\n\n## 수정\n바꿨다\n`);
  }
  const group = readTicket("QA-0006");
  const feedback = groupFeedback(group);
  assert.match(feedback, /같은 원인으로 생기는 다른 곳을 찾는다/);
  assert.match(feedback, /### QA-0001\n\n#### QA-0001 제목\n\n## 재현 절차/);
  assert.doesNotMatch(feedback, /## 수정/);
  const screen = ticketScreen(group, loadScreens());
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s", feedback, excludeTicket: [group.id, ...group.group.members], limits: { files: 30, lines: 1500 } }));
  assert.doesNotMatch(p, /undefined|\{\{(?!SCREENSHOTS)\w+\}\}/);
  assert.match(p, /파일 30개, 추가·삭제 1500줄/);
  assert.doesNotMatch(p, /- QA-0001 \[/);
});

test("explore sessions skip causes a group is fixing", () => {
  const screen = loadScreens().find((s) => s.id === "usage");
  const p = renderPrompt("implement", implementVars(screen, { shotsDir: "/s" }));
  assert.match(p, /### 묶음으로 고치는 중인 원인[\s\S]*`focus-not-returned` \(QA-0006\)/);
});

test("a merged group closes its tickets; a rejected one hands them back for good", () => {
  const group = { ...readTicket("QA-0006"), pr: { number: 9, url: "u" } };
  closeMembers(group, "merged");
  assert.equal(readTicket("QA-0001").status, "merged");
  assert.deepEqual(readTicket("QA-0001").resolvedBy, { number: 9, url: "u" });

  single("QA-0010", { status: "grouped", groupId: "QA-0011", groupFrom: "needs-human", cause: focus });
  single("QA-0012", { status: "grouped", groupId: "QA-0011", groupFrom: "awaiting", cause: focus });
  single("QA-0013", { status: "grouped", groupId: "QA-0011", groupFrom: "awaiting", cause: focus });
  releaseMembers({ group: { members: ["QA-0010", "QA-0012", "QA-0013"] } });
  assert.equal(readTicket("QA-0010").status, "needs-human");
  assert.equal(readTicket("QA-0010").groupRejected, true);
  assert.equal(groupPlan(listTickets().filter((t) => t.id !== "QA-0006")), null);
});
