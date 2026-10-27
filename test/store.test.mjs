import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-store-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const store = await import("../lib/store.mjs");
const { problemOnly } = await import("../lib/agent.mjs");
const { acquireLock } = await import("../lib/lock.mjs");

const base = { screen: "chat", title: "t", attempt: 1, implement: { engine: "claude" }, pr: null };

test("ticket ids count up", () => {
  assert.equal(store.nextTicketId([]), "QA-0001");
  assert.equal(store.nextTicketId([{ id: "QA-0009" }, { id: "QA-0002" }]), "QA-0010");
});

test("the exploration cap counts the 승인 대기 column: awaiting and needs-human, not final-review", () => {
  const tickets = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `QA-${i}`, status: "awaiting" })),
    { id: "QA-n", status: "needs-human" },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `QA-f${i}`, status: "final-review" })),
    { id: "QA-x", status: "pr-fixing" },
    { id: "QA-y", status: "revising" },
  ];
  assert.equal(store.approvalWaiting(tickets), 9);
  assert.equal(store.overApprovalCap(tickets), false);
  assert.equal(store.overApprovalCap([...tickets, { id: "QA-z", status: "awaiting" }]), true);
  assert.equal(store.overApprovalCap([...tickets, { id: "QA-m", status: "needs-human" }]), true);
  assert.equal(store.overApprovalCap([...tickets, { id: "QA-g", status: "final-review" }]), false);
});

test("transition only moves out of the expected status", () => {
  store.createTicket({ ...base, id: "QA-0001", status: "awaiting" });
  store.transition("QA-0001", "awaiting", { status: "rejected", rejectReason: "의도된 동작" });
  assert.equal(store.readTicket("QA-0001").status, "rejected");
  assert.throws(() => store.transition("QA-0001", "awaiting", { status: "revising" }), /status is rejected/);
  assert.throws(() => store.transition("QA-0001", "rejected", { status: "nope" }), /unknown status/);
});

test("listTickets reads what createTicket wrote", () => {
  store.createTicket({ ...base, id: "QA-0002", status: "awaiting" });
  assert.deepEqual(
    store.listTickets().map((t) => t.id),
    ["QA-0001", "QA-0002"],
  );
});

test("revise sees the problem but not the earlier fix", () => {
  const md = "# 제목\n\n## 요약\n고쳤다\n\n## 재현 절차\n1. 연다\n\n## 기대 동작과 실제 동작\n- 기대: a\n\n## 원인\n버그\n\n## 수정\nX를 바꿨다\n";
  const out = problemOnly(md);
  assert.match(out, /재현 절차/);
  assert.match(out, /기대 동작과 실제 동작/);
  assert.doesNotMatch(out, /X를 바꿨다|## 원인|## 요약/);
});

test("a second lock holder is refused", () => {
  const file = join(process.env.FIELDTEST_DATA, "run", "t.lock");
  const release = acquireLock(file);
  assert.ok(release);
  assert.equal(acquireLock(file), null);
  release();
  assert.ok(acquireLock(file));
});

test("child process groups are killed when the parent exits", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const script = join(process.env.FIELDTEST_DATA, "parent.mjs");
  writeFileSync(
    script,
    `import { run, trackChildren } from ${JSON.stringify(new URL("../lib/exec.mjs", import.meta.url).href)};
     trackChildren(${JSON.stringify(join(process.env.FIELDTEST_DATA, "children.json"))});
     run("sleep", ["30"]);
     setTimeout(() => process.exit(0), 300);`,
  );
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.FIELDTEST_DATA, "children.json"), "utf8")), []);
  const alive = spawnSync("pgrep", ["-f", "^sleep 30$"], { encoding: "utf8" }).stdout.trim();
  assert.equal(alive, "", "sleep 30 should be gone");
});

test("every ticket status has a board label", async () => {
  const { STATUS_LABEL, STATUSES } = await import("../lib/store.mjs");
  for (const s of STATUSES) assert.ok(["승인 대기", "진행 중", "최종 검토", "종료"].includes(STATUS_LABEL[s]), s);
  assert.equal(STATUS_LABEL["needs-human"], "승인 대기");
  assert.equal(STATUS_LABEL.merged, "종료");
});
