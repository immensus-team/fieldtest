import assert from "node:assert/strict";
import { test } from "node:test";

process.env.FIELDTEST_DATA ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ft-"));
const { MONOREPO, useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe(MONOREPO);
const { addedTests, oneAtATime, parseDiff, parseNameStatus, parseTestList, reproTests, testTampering } = await import("../lib/gate.mjs");
const { globToRegExp, outOfScope, parseScreen } = await import("../lib/screens.mjs");

const diffOf = (path, removed, added) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");

test("parseNameStatus reads adds, renames and deletes", () => {
  const out = parseNameStatus("A\tapps/web/e2e/new.spec.ts\nR100\told.ts\tnew.ts\nD\tapps/web/e2e/gone.spec.ts\n");
  assert.deepEqual(out, [
    { status: "A", path: "apps/web/e2e/new.spec.ts", from: null },
    { status: "R", path: "new.ts", from: "old.ts" },
    { status: "D", path: "apps/web/e2e/gone.spec.ts", from: null },
  ]);
});

test("deleting a test file blocks", () => {
  const r = testTampering([{ status: "D", path: "apps/web/e2e/theme.spec.ts" }], {});
  assert.equal(r.blocking.length, 1);
});

test("adding .skip or .only blocks even with an explanation", () => {
  const path = "apps/web/e2e/theme.spec.ts";
  const diff = parseDiff(diffOf(path, ['test("dark", async () => {'], ['test.skip("dark", async () => {']));
  const r = testTampering([{ status: "M", path }], diff, { explained: true });
  assert.match(r.blocking[0], /비활성화/);
});

test("fewer expects blocks without a reason and becomes a note with one", () => {
  const path = "apps/web/src/lib/x.test.ts";
  const diff = parseDiff(diffOf(path, ["expect(a).toBe(1);", "expect(b).toBe(2);"], ["expect(a).toBe(1);"]));
  assert.equal(testTampering([{ status: "M", path }], diff).blocking.length, 1);
  const explained = testTampering([{ status: "M", path }], diff, { explained: true });
  assert.equal(explained.blocking.length, 0);
  assert.equal(explained.notes.length, 1);
});

test("a new spec with expects is fine", () => {
  const path = "apps/web/e2e/composer-overflow.spec.ts";
  const diff = parseDiff(diffOf(path, [], ["expect(page).toBeVisible();"]));
  assert.deepEqual(testTampering([{ status: "A", path }], diff), { blocking: [], notes: [] });
});

test("reproTests sorts a fix's tests into proof, new spec, changed spec and unit", () => {
  const r = reproTests([
    { status: "A", path: "apps/web/e2e/proof/composer-overflow.spec.ts" },
    { status: "A", path: "apps/web/e2e/composer-overflow.spec.ts" },
    { status: "M", path: "apps/web/e2e/composer.spec.ts" },
    { status: "M", path: "apps/web/src/lib/format.test.ts" },
    { status: "A", path: "apps/web/e2e/helpers/thing.ts" },
    { status: "D", path: "apps/web/e2e/old.spec.ts" },
    { status: "M", path: "apps/web/src/components/a.tsx" },
  ]);
  assert.deepEqual(r, {
    proof: ["apps/web/e2e/proof/composer-overflow.spec.ts"],
    newSpecs: ["apps/web/e2e/composer-overflow.spec.ts"],
    changedSpecs: ["apps/web/e2e/composer.spec.ts"],
    unit: ["apps/web/src/lib/format.test.ts"],
  });
});

test("only tests a changed spec did not have before run as its repro", () => {
  const list = (titles) =>
    parseTestList(["Listing tests:", ...titles.map(([line, t]) => `  [chromium] › composer.spec.ts:${line}:5 › ${t}`), "Total: 2 tests in 1 file"].join("\n"));
  const before = list([[10, "sends on Enter"], [30, "keeps a draft"]]);
  const after = list([[10, "sends on Enter"], [30, "keeps a draft"], [52, "keeps focus after a failed send at 390px"], [52, "keeps focus after a failed send at 1440px"]]);
  assert.deepEqual(before[0], { file: "composer.spec.ts", line: 10, title: "sends on Enter" });
  assert.deepEqual(addedTests(before, after), ["composer.spec.ts:52"]);
  assert.deepEqual(addedTests(after, after), []);
});

test("changed visual baselines block", () => {
  const r = testTampering([{ status: "M", path: "apps/web/e2e/theme.spec.ts-snapshots/dark.png" }], {});
  assert.equal(r.blocking.length, 1);
});

test("globs", () => {
  assert.ok(globToRegExp("apps/web/src/**").test("apps/web/src/components/a.tsx"));
  assert.ok(globToRegExp("**/package.json").test("package.json"));
  assert.ok(globToRegExp("**/package.json").test("apps/web/package.json"));
  assert.ok(!globToRegExp("apps/*/x.ts").test("apps/web/src/x.ts"));
});

test("scope: forbidden wins over allowed", () => {
  const allowed = ["apps/web/src/app/**", "apps/web/e2e/**"];
  assert.deepEqual(outOfScope(["apps/web/src/app/page.tsx", "apps/web/e2e/a.spec.ts"], allowed), []);
  assert.deepEqual(outOfScope(["apps/web/src/app/api/route.ts"], allowed), ["apps/web/src/app/api/route.ts"]);
  assert.deepEqual(outOfScope(["apps/web/src/server/db.ts"], allowed), ["apps/web/src/server/db.ts"]);
  assert.deepEqual(outOfScope(["apps/web/package.json"], ["apps/web/**"]), ["apps/web/package.json"]);
});

test("parseScreen reads the header and mission", () => {
  const s = parseScreen("---\nid: chat\nurl: /demo/files?thread=thread-A\nspecs: composer, theme\n---\n대화 화면이다.\n");
  assert.equal(s.id, "chat");
  assert.deepEqual(s.specs, ["composer", "theme"]);
  assert.ok(s.paths.length > 0);
  assert.equal(s.mission, "대화 화면이다.");
});

const { changeSize, oversized } = await import("../lib/gate.mjs");
const { MAX_CHANGED_FILES, MAX_CHANGED_LINES } = await import("../lib/config.mjs");

test("bypass patterns on added lines block without a reason", () => {
  const cases = [
    ["apps/web/src/components/a.tsx", "// biome-ignore lint/a11y: x"],
    ["apps/web/src/components/a.tsx", "// @ts-ignore"],
    ["apps/web/src/components/a.tsx", "// @ts-expect-error broken"],
    ["apps/web/src/components/a.tsx", "// @ts-nocheck"],
    ["apps/web/src/components/a.tsx", "const v = x as any;"],
    ["apps/web/e2e/theme.spec.ts", "await page.waitForTimeout(500);"],
    ["apps/web/e2e/theme.spec.ts", "await button.click({ force: true });"],
    ["apps/web/e2e/theme.spec.ts", "test.slow();"],
    ["apps/web/e2e/theme.spec.ts", "test.setTimeout(120000);"],
    ["apps/web/e2e/theme.spec.ts", 'test.describe.configure({ mode: "serial", timeout: 120000 });'],
  ];
  for (const [path, line] of cases) {
    const diff = parseDiff(diffOf(path, [], [line]));
    const r = testTampering([{ status: "M", path }], diff);
    assert.equal(r.blocking.length, 1, `${path}: ${line}`);
  }
});

test("test-only patterns are fine in app code, removed lines are ignored", () => {
  const path = "apps/web/src/components/a.tsx";
  const diff = parseDiff(diffOf(path, ["// @ts-ignore"], ["setTimeout(() => close(), 200);"]));
  assert.deepEqual(testTampering([{ status: "M", path }], diff), { blocking: [], notes: [] });
});

test("bypass patterns become reviewer notes when a reason is given", () => {
  const path = "apps/web/e2e/theme.spec.ts";
  const diff = parseDiff(diffOf(path, [], ["await page.waitForTimeout(500);"]));
  const r = testTampering([{ status: "M", path }], diff, { explained: true });
  assert.equal(r.blocking.length, 0);
  assert.match(r.notes[0], /waitForTimeout/);
});

test("size cap counts tests like code, but not proof specs", () => {
  const proof = "apps/web/e2e/proof/new.spec.ts";
  const spec = "apps/web/e2e/composer.spec.ts";
  const src = "apps/web/src/components/a.tsx";
  const big = Array.from({ length: 400 }, (_, i) => `line ${i}`);
  const diff = { ...parseDiff(diffOf(proof, [], big)), ...parseDiff(diffOf(spec, [], ["one", "two"])), ...parseDiff(diffOf(src, ["a"], ["b"])) };
  const size = changeSize(
    [
      { status: "A", path: proof },
      { status: "M", path: spec },
      { status: "M", path: src },
    ],
    diff,
  );
  assert.deepEqual(size, { files: 2, lines: 4 });
  assert.equal(oversized(size), null);
  assert.match(oversized({ files: MAX_CHANGED_FILES + 1, lines: 0 }), /변경 파일/);
  assert.match(oversized({ files: 1, lines: MAX_CHANGED_LINES + 1 }), /줄/);
  assert.equal(oversized({ files: MAX_CHANGED_FILES, lines: MAX_CHANGED_LINES }), null);
});

test("oneAtATime runs checks in turn, and a failure does not stop the next", async () => {
  const events = [];
  const job = (name, fail) => async () => {
    events.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, 10));
    events.push(`end ${name}`);
    if (fail) throw new Error(name);
  };
  const a = oneAtATime(job("a", true));
  const b = oneAtATime(job("b"));
  await assert.rejects(a, /a/);
  await b;
  assert.deepEqual(events, ["start a", "end a", "start b", "end b"]);
});

test("a screen's paths narrow the recipe's allowed paths but never widen them", () => {
  // scripts/ is neither allowed nor forbidden by the recipe: a screen guide naming it must not open it.
  assert.deepEqual(outOfScope(["scripts/tool.mjs"], ["scripts/**"]), ["scripts/tool.mjs"]);
  assert.deepEqual(outOfScope(["apps/web/src/lib/a.ts"], ["apps/web/src/components/**"]), ["apps/web/src/lib/a.ts"]);
  assert.deepEqual(outOfScope(["apps/web/src/components/a.tsx"], ["apps/web/src/components/**"]), []);
});

test("the e2e setup ticket may go past the recipe's paths, as its scope says", async () => {
  const { setupScope } = await import("../lib/repair.mjs");
  const { currentRecipe } = await import("../lib/recipe.mjs");
  const scope = setupScope({ id: "home", paths: ["apps/web/src/components/**"] }, currentRecipe());
  assert.deepEqual(outOfScope(["apps/web/package.json"], scope.paths, scope.forbidden, scope.ceiling), []);
});
