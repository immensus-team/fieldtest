import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// An install that skipped Slack: no slack.env. The dashboard is the only channel, so notices are dropped.
process.env.HOME = mkdtempSync(join(tmpdir(), "ft-noslack-home-"));
process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-noslack-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  throw new Error("no network");
};
const { COMMANDS_FILE, QUEUE_DIR, enqueue, slackCommands, slackNotice, slackTicketNotice } = await import("../lib/slack.mjs");

test("without Slack, notices are dropped instead of failing the watch", async () => {
  await slackNotice("main 검사 실패", { log: "log" });
  await slackTicketNotice("QA-0001", "자동 머지를 멈췄습니다");
  assert.equal(calls, 0);
});

test("without Slack, the dashboard's queued commands still run", async () => {
  enqueue({ id: "QA-0099", verb: "승인", arg: "", source: "web" });
  assert.equal(await slackCommands({ log: () => {} }), 1);
  assert.deepEqual(readdirSync(QUEUE_DIR), []);
  const last = JSON.parse(readFileSync(COMMANDS_FILE, "utf8").trim().split("\n").pop());
  assert.equal(last.id, "QA-0099");
  assert.equal(last.source, "web");
  assert.equal(last.message, "티켓이 없습니다");
  assert.equal(calls, 0);
  assert.ok(existsSync(COMMANDS_FILE));
});
