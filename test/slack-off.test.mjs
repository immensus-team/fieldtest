import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
const { slackNotice, slackTicketNotice } = await import("../lib/slack.mjs");

test("without Slack, notices are dropped instead of failing the watch", async () => {
  await slackNotice("main 검사 실패", { log: "log" });
  await slackTicketNotice("QA-0001", "자동 머지를 멈췄습니다");
  assert.equal(calls, 0);
});
