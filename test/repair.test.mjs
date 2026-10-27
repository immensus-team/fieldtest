import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-repair-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { exploreBlocked, recipeHash, setupScope, setupTicketNeeded } = await import("../lib/repair.mjs");
const { currentRecipe } = await import("../lib/recipe.mjs");

test("the e2e setup ticket may change package files, the Playwright config and the e2e directory", () => {
  const scope = setupScope({ id: "home", paths: ["web/src/**"] }, currentRecipe());
  for (const p of ["**/package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "**/playwright.config.*", "web/e2e/**"]) assert.ok(scope.paths.includes(p), p);
  assert.ok(!scope.forbidden.includes("**/package.json"));
});

test("exploration waits for a repair, a failed recipe, a recipe approval or an unmerged e2e setup", () => {
  assert.equal(exploreBlocked([], {}), null);
  assert.match(exploreBlocked([], { repair: { reason: "x" } }), /수리/);
  assert.match(exploreBlocked([], { stage: "failed", error: "e" }), /실행 지침 검증 실패/);
  assert.match(exploreBlocked([], { awaitingApproval: ["checks"] }), /승인/);
  assert.match(exploreBlocked([{ id: "QA-0001", setup: true, status: "proposal" }], {}), /e2e 준비 PR/);
  assert.equal(exploreBlocked([{ id: "QA-0001", setup: true, status: "merged" }], {}), null);
});

test("a setup ticket is made once, when the recipe says Playwright is missing", () => {
  const state = { needsE2eSetup: true, e2eSetup: { title: "e2e 준비", spec: "## 문제\n..." } };
  assert.equal(setupTicketNeeded([], state), true);
  assert.equal(setupTicketNeeded([{ setup: true, status: "rejected" }], state), false);
  assert.equal(setupTicketNeeded([], { needsE2eSetup: false }), false);
});

test("the base check cache key changes with the recipe", () => {
  const a = recipeHash(currentRecipe());
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, recipeHash({ ...currentRecipe(), install: ["npm i"] }));
});
