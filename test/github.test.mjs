import assert from "node:assert/strict";
import { test } from "node:test";

process.env.FIELDTEST_DATA ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ft-"));
const { MONOREPO, useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe(MONOREPO);
const { replaceBlock } = await import("../lib/github.mjs");
const { withScreenshots } = await import("../lib/publish.mjs");


test("replaceBlock replaces between markers or appends", () => {
  const once = replaceBlock("body", "gaps", "- a");
  assert.match(once, /<!-- quality:gaps -->\n- a\n<!-- \/quality:gaps -->/);
  const twice = replaceBlock(once, "gaps", "- b");
  assert.ok(!twice.includes("- a"));
  assert.equal(twice.match(/quality:gaps -->/g).length, 2);
});

test("screenshots fill the template placeholder, later rounds replace the block", () => {
  const first = withScreenshots("### Screenshots\n\n{{SCREENSHOTS}}\n", "![a](x)");
  assert.ok(!first.includes("{{SCREENSHOTS}}"));
  const second = withScreenshots(first, "![b](y)");
  assert.ok(second.includes("![b](y)"));
  assert.ok(!second.includes("![a](x)"));
});

const { withGateResult } = await import("../lib/publish.mjs");

test("the PR body gets the gate result and ticks the checks it ran", () => {
  const body = "## Test\n\n- [ ] Local test\n- [ ] Lint\n- [ ] Typecheck\n- [ ] Unit test\n- [ ] Build\n";
  const gate = { ok: true, steps: ["Lint", "Typecheck", "재현 테스트 통과 1/3", "Unit test", "Build"].map((name) => ({ name, ok: true })) };
  const out = withGateResult(body, gate);
  assert.match(out, /### 실행기 검증 \(게이트\)/);
  for (const box of ["Local test", "Lint", "Typecheck", "Unit test", "Build"]) assert.ok(out.includes(`- [x] ${box}`), box);
  assert.equal(withGateResult(body, null), body);
});

const { checkOfRollup, judgeChecks } = await import("../lib/github.mjs");

test("a required check that isn't reported yet keeps the PR pending", () => {
  const required = ["ci", "desktop (cargo check)"];
  const early = [
    { name: "desktop (cargo check)", bucket: "skipping" },
    { name: "test (1)", bucket: "pending" },
  ];
  assert.equal(judgeChecks(early, required).pending, true);
  assert.deepEqual(judgeChecks(early, required).missing, ["ci"]);
  const done = [...early.slice(0, 1), { name: "test (1)", bucket: "pass" }, { name: "ci", bucket: "pass" }];
  assert.deepEqual(judgeChecks(done, required), { pending: false, failing: [], optional: [], missing: [] });
  const failed = [{ name: "e2e", bucket: "fail" }, { name: "ci", bucket: "fail" }, { name: "desktop (cargo check)", bucket: "skipping" }];
  const r = judgeChecks(failed, required);
  assert.equal(r.pending, false);
  assert.deepEqual(r.failing.map((c) => c.name), ["e2e", "ci"]);
});

test("a run cancelled by a newer run of the same workflow is not a failure", () => {
  const checks = [
    { name: "test", bucket: "cancel", workflow: "ci", startedAt: "2026-10-18T18:30:02Z" },
    { name: "ci", bucket: "pass", workflow: "ci", startedAt: "2026-10-18T18:42:02Z" },
  ];
  assert.deepEqual(judgeChecks(checks, ["ci"]), { pending: false, failing: [], optional: [], missing: [] });
  const alone = [{ name: "ci", bucket: "cancel", workflow: "ci", startedAt: "2026-10-18T18:30:02Z" }];
  assert.deepEqual(judgeChecks(alone, ["ci"]).failing.map((c) => c.name), ["ci"]);
});

test("the draft run's skipped ci does not pass the PR while the ready run's ci is unreported", () => {
  const job = (name, run, bucket) => ({ name, bucket, workflow: "ci", link: `https://github.com/o/r/actions/runs/${run}/job/${run}${name.length}` });
  const draft = [job("test", 100, "skipping"), job("ci", 100, "skipping")];
  const ready = [job("test", 200, "pass"), job("e2e / e2e (chromium)", 200, "pending")];
  const r = judgeChecks([...draft, ...ready], ["ci"]);
  assert.equal(r.pending, true);
  assert.deepEqual(r.missing, ["ci"]);
  assert.deepEqual(judgeChecks([...draft, ...ready.slice(0, 1), job("ci", 200, "pass")], ["ci"]), { pending: false, failing: [], optional: [], missing: [] });
});

test("only a failed required check fails the PR; it brings its workflow's failed jobs along", () => {
  const vercel = { name: "Vercel", bucket: "fail", workflow: "", description: "Deployment has failed" };
  const passed = [{ name: "ci", bucket: "pass", workflow: "ci" }, vercel];
  assert.deepEqual(judgeChecks(passed, ["ci"]), { pending: false, failing: [], optional: [vercel], missing: [] });
  const e2e = { name: "e2e", bucket: "fail", workflow: "ci" };
  const r = judgeChecks([e2e, { name: "ci", bucket: "fail", workflow: "ci" }, vercel], ["ci"]);
  assert.deepEqual(r.failing.map((c) => c.name), ["e2e", "ci"]);
  assert.deepEqual(r.optional, [vercel]);
});

const { assetShots, mergeShots, screenshotTable, shotsInBody } = await import("../lib/publish.mjs");

test("PR screenshots form a 화면 | 수정 전 | 수정 후 table, narrow screens first and light before dark", () => {
  const names = ["after-1440-dark.png", "after-1440-light.png", "after-390-dark.png", "after-390-light.png", "before-1440-dark.png", "before-1440-light.png", "before-390-dark.png", "before-390-light.png"];
  const table = screenshotTable(assetShots({ assetSha: "abc", rel: "docs/pr-assets/qa-1" }, names));
  const lines = table.split("\n");
  assert.equal(lines[0], "| 화면 | 수정 전 | 수정 후 |");
  assert.deepEqual(lines.slice(2).map((l) => l.split(" | ")[0].slice(2)), ["390px · 라이트", "390px · 다크", "1440px · 라이트", "1440px · 다크"]);
  assert.match(lines[2], /alt="before-390-light"> \| <img src="[^"]+\/after-390-light\.png\?raw=true" width="360"/);
  assert.equal(screenshotTable([]), "스크린샷 없음");
});

test("old PR bodies are read back and a later round keeps the before images", () => {
  const url = (f) => `https://github.com/acme/shop/blob/aaa/docs/pr-assets/qa-0005/${f}?raw=true`;
  const body = `### Screenshots\n\n<!-- quality:screenshots -->\n![after-390-light](${url("after-390-light.png")})\n![before-390-light](${url("before-390-light.png")})\n<!-- /quality:screenshots -->\n`;
  const old = shotsInBody(body);
  assert.deepEqual(old.map((e) => e.name).sort(), ["after-390-light.png", "before-390-light.png"]);
  assert.deepEqual(shotsInBody(`<!-- quality:screenshots -->\n${screenshotTable(old)}\n<!-- /quality:screenshots -->`).map((e) => e.name).sort(), ["after-390-light.png", "before-390-light.png"]);
  const merged = mergeShots(old, assetShots({ assetSha: "bbb", rel: "docs/pr-assets/qa-0005-r1" }, ["after-390-light.png"]));
  assert.equal(merged.find((e) => e.name === "before-390-light.png").url, url("before-390-light.png"));
  assert.match(merged.find((e) => e.name === "after-390-light.png").url, /\/bbb\/docs\/pr-assets\/qa-0005-r1\//);
});

test("the rollup keeps both runs' ci, so the ready run's pass counts over the draft run's skip", () => {
  const run = (id, name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, workflowName: "ci", startedAt: `t${id}`, detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1` });
  const rollup = [run(100, "ci", "SKIPPED"), run(200, "ci", "SUCCESS"), { __typename: "StatusContext", context: "AWS CodeBuild", state: "SUCCESS", targetUrl: "u" }];
  assert.deepEqual(judgeChecks(rollup.map(checkOfRollup), ["ci"]), { pending: false, failing: [], optional: [], missing: [] });
  assert.equal(checkOfRollup({ __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" }).bucket, "pending");
  assert.equal(checkOfRollup({ __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "TIMED_OUT" }).bucket, "fail");
  assert.equal(checkOfRollup({ __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "CANCELLED" }).bucket, "cancel");
});
