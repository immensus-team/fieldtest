import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-reject-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
// A fake gh answers `pr view` with $GH_STATE and records every call.
const bin = mkdtempSync(join(tmpdir(), "uq-reject-bin-"));
const calls = join(bin, "calls.log");
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh\necho "$*" >> ${calls}\nif [ "$2" = view ]; then echo "{\\"number\\":7,\\"state\\":\\"$GH_STATE\\"}"; fi\n`,
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const store = await import("../lib/store.mjs");
const { reject } = await import("../lib/human.mjs");

const finalReview = (id) =>
  store.createTicket({ id, status: "final-review", screen: "chat", title: "t", attempt: 1, implement: { engine: "claude" }, pr: { number: 7, round: 0 }, autoMerge: { at: "x" } });
const ghCalls = () => readFileSync(calls, "utf8");

test("거절 on a final-review ticket closes its open PR and ends the ticket", async () => {
  writeFileSync(calls, "");
  process.env.GH_STATE = "OPEN";
  finalReview("QA-0001");
  assert.match(await reject("QA-0001", "필요 없음"), /PR #7을 merge하지 않고 닫고 거절했습니다/);
  assert.match(ghCalls(), /^pr close 7 .*--comment 리뷰어가 거절해 merge하지 않고 닫습니다\. 이유: 필요 없음$/m);
  const t = store.readTicket("QA-0001");
  assert.equal(t.status, "rejected");
  assert.equal(t.rejectReason, "필요 없음");
  assert.equal(t.autoMerge, null);
});

test("a PR closed already is not closed again; a merged one refuses", async () => {
  writeFileSync(calls, "");
  process.env.GH_STATE = "CLOSED";
  finalReview("QA-0002");
  await reject("QA-0002", "x");
  assert.doesNotMatch(ghCalls(), /pr close/);
  assert.equal(store.readTicket("QA-0002").status, "rejected");

  process.env.GH_STATE = "MERGED";
  finalReview("QA-0003");
  await assert.rejects(reject("QA-0003", "x"), /이미 merge된 PR/);
  assert.equal(store.readTicket("QA-0003").status, "final-review");
});
