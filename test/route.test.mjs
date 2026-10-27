import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { routeOf as route, sourceChanges as changes } from "../lib/route.mjs";

// A recipe with the automatic route rule the first 69 merged tickets supported (3 files, 80 lines, copy).
const R = {
  ...JSON.parse(readFileSync(new URL("./fixtures/recipe/recipe.json", import.meta.url), "utf8")),
  e2e: { cwd: "apps/web", dir: "apps/web/e2e", playwright: "npx playwright", project: "chromium" },
  autoRoute: { files: 3, lines: 80, copyCheck: true },
  uiLanguage: "ko",
};
const AUTO_LIMITS = R.autoRoute;
const routeOf = (t, patch, recipe = R) => route(t, patch, recipe);
const sourceChanges = (patch, recipe = R) => changes(patch, recipe);

const file = (path, lines) => [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@", ...lines].join("\n");
const code = (n) => Array.from({ length: n }, (_, i) => `+  const v${i} = ${i};`);
const ticket = (extra = {}) => ({ id: "QA-0099", status: "awaiting", severity: "low", kind: "functional", attempt: 1, ...extra });

test("specs and tests don't count; changed lines and Korean text do", () => {
  const patch = [
    file("apps/web/e2e/usage.spec.ts", [...code(40), '+  await expect(page.getByText("사용량")).toBeVisible();']),
    file("apps/web/src/lib/format.test.ts", code(5)),
    file("apps/web/src/components/usage/usage-page.tsx", [" context", "-  return a;", "+  return b;"]),
    file("apps/web/src/components/usage/usage-page.css", ['+  content: "없음";']),
  ].join("\n");
  assert.deepEqual(sourceChanges(patch), [
    { path: "apps/web/src/components/usage/usage-page.tsx", lines: 2, copy: false },
    { path: "apps/web/src/components/usage/usage-page.css", lines: 1, copy: true },
  ]);
});

test("a small functional fix of low or medium severity goes on its own", () => {
  const patch = [file("apps/web/e2e/a.spec.ts", code(60)), file("apps/web/src/components/a.tsx", code(AUTO_LIMITS.lines))].join("\n");
  assert.deepEqual(routeOf(ticket(), patch), { auto: true, reasons: [] });
  assert.deepEqual(routeOf(ticket({ severity: "medium" }), patch), { auto: true, reasons: [] });
});

test("high severity, visual, groups, human revisions, size and copy go to the human", () => {
  const small = file("apps/web/src/components/a.tsx", code(3));
  const reasons = (t, patch = small) => routeOf(t, patch).reasons;
  assert.deepEqual(reasons(ticket({ severity: "high" })), ["심각도 high"]);
  assert.deepEqual(reasons(ticket({ kind: "visual" })), ["시각 수정"]);
  assert.deepEqual(reasons(ticket({ kind: null, group: { members: ["QA-0001"] } })), ["묶음 수정"]);
  assert.deepEqual(reasons(ticket({ humanTouched: true })), ["사람이 수정을 요청함"]);
  assert.deepEqual(reasons(ticket({ status: "needs-human" })), ["판단 필요"]);
  const four = ["a", "b", "c", "d"].map((n) => file(`apps/web/src/components/${n}.tsx`, code(1))).join("\n");
  assert.deepEqual(reasons(ticket(), four), ["소스 4파일 (자동 상한 3)"]);
  assert.deepEqual(reasons(ticket(), file("apps/web/src/components/a.tsx", code(81))), ["소스 81줄 (자동 상한 80)"]);
  const copy = file("apps/web/src/components/notice.tsx", ['-  "저장하지 못했습니다. 잠시 후 다시 시도해 주세요."', '+  "저장하지 못했습니다"']);
  assert.deepEqual(reasons(ticket(), copy), ["화면 문구 변경 (notice.tsx)"]);
  const removed = file("apps/web/src/components/notice.tsx", ['-  <p>안내</p>']);
  assert.equal(routeOf(ticket(), removed).auto, false, "removing a sentence changes the copy too");
});

test("an improvement always goes to the human", () => {
  const small = file("apps/web/src/components/a.tsx", code(3));
  assert.deepEqual(routeOf(ticket({ track: "improve" }), small), { auto: false, reasons: ["개선 티켓"] });
});

test("a repo without an automatic route rule sends every ticket to the human", () => {
  const small = file("apps/web/src/components/a.tsx", code(3));
  assert.deepEqual(routeOf(ticket(), small, { ...R, autoRoute: null }), { auto: false, reasons: ["이 레포는 자동 경로 규칙이 없음"] });
});

test("in an English UI a changed string literal or JSX text is copy; plain code is not", () => {
  const en = { ...R, uiLanguage: "en" };
  assert.deepEqual(sourceChanges(file("apps/web/src/components/a.tsx", ["+  return <p>Save changes</p>;"]), en), [{ path: "apps/web/src/components/a.tsx", lines: 1, copy: true }]);
  assert.deepEqual(sourceChanges(file("apps/web/src/components/b.tsx", ['+  toast("Could not save");']), en)[0].copy, true);
  assert.deepEqual(sourceChanges(file("apps/web/src/components/c.tsx", ["+  const v = count + 1;"]), en)[0].copy, false);
});
