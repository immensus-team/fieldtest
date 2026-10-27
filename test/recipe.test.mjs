import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fill, GATE_KEYS, loadRecipe, recipeChanges, recipeScreensDir, validateRecipe } from "../lib/recipe.mjs";

const FIXTURE = new URL("./fixtures/recipe", import.meta.url).pathname;
const base = () => JSON.parse(readFileSync(join(FIXTURE, "recipe.json"), "utf8"));

test("the fixture recipe loads without errors and knows its directory", () => {
  const r = loadRecipe(FIXTURE);
  assert.equal(r.repo, "acme/shop");
  assert.equal(r.dir, FIXTURE);
  assert.equal(recipeScreensDir(r), join(FIXTURE, "screens"));
  assert.deepEqual(validateRecipe(base()), []);
});

test("an unknown app kind and an empty check list are errors", () => {
  assert.ok(validateRecipe({ ...base(), app: { kind: "ios", root: "." } }).some((e) => e.includes("app.kind")));
  assert.ok(validateRecipe({ ...base(), checks: [] }).some((e) => e.includes("checks")));
});

test("form login needs an account and init-page login needs a page", () => {
  assert.ok(validateRecipe({ ...base(), login: { kind: "form" } }).some((e) => e.includes("login.account")));
  assert.ok(validateRecipe({ ...base(), login: { kind: "init-page" } }).some((e) => e.includes("login.initPage")));
});

test("loadRecipe refuses a broken recipe", () => {
  assert.throws(() => loadRecipe(join(FIXTURE, "screens")), /레시피/);
});

test("a check change needs the human; a seed change does not", () => {
  const prev = base();
  assert.deepEqual(recipeChanges(prev, { ...prev, checks: [{ name: "x", command: "true", stage: "fast" }] }), { gate: ["checks"], other: [] });
  assert.deepEqual(recipeChanges(prev, { ...prev, seed: ["npm run seed"] }), { gate: [], other: ["seed"] });
  assert.ok(GATE_KEYS.includes("paths") && GATE_KEYS.includes("autoRoute"));
});

test("fill swaps known placeholders and keeps unknown ones", () => {
  assert.equal(fill("x {port} {files}", { port: 3200, files: "a b" }), "x 3200 a b");
  assert.equal(fill("y {other}", { port: 1 }), "y {other}");
});

test("ci is optional but needs a workflow when present", () => {
  assert.deepEqual(validateRecipe({ ...base(), ci: null }), []);
  assert.deepEqual(validateRecipe({ ...base(), ci: { workflow: "ci.yml" } }), []);
  assert.ok(validateRecipe({ ...base(), ci: {} }).some((e) => e.includes("ci.workflow")));
});

test("currentRecipe reads the approved recipe again after it changes", async () => {
  const { cpSync, mkdtempSync, utimesSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { currentRecipe } = await import("../lib/recipe.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ft-recipe-"));
  cpSync(FIXTURE, dir, { recursive: true });
  assert.equal(currentRecipe(dir).repo, "acme/shop");
  writeFileSync(join(dir, "recipe.json"), JSON.stringify({ ...base(), repo: "acme/shop2" }));
  utimesSync(join(dir, "recipe.json"), new Date(), new Date(Date.now() + 5000));
  assert.equal(currentRecipe(dir).repo, "acme/shop2");
});

test("a form login also needs the init page that signs in", () => {
  const login = { kind: "form", account: { url: "/login", user: "a@b.test", password: "pw" } };
  assert.ok(validateRecipe({ ...base(), login }).some((e) => e.includes("login.initPage")));
  assert.deepEqual(validateRecipe({ ...base(), login: { ...login, initPage: "recipe:login.mjs" } }), []);
});
