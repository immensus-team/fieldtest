import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "ft-bootstrap-"));
process.env.FIELDTEST_DATA = join(root, "data");
process.env.FIELDTEST_APPROVED = join(root, "approved");
mkdirSync(join(process.env.FIELDTEST_DATA, "run"), { recursive: true });
// A free port for the demo app, so the test never meets a real one on 3200.
process.env.FIELDTEST_DEMO_PORT = String(
  await new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  }),
);
const { verifyRecipe, promoteDraft, readRecipeState } = await import("../lib/bootstrap.mjs");
const { paths } = await import("../lib/config.mjs");

// The app under test: a git repo with a tiny server and a stand-in for Playwright.
const app = join(root, "app");
cpSync(new URL("./fixtures/app", import.meta.url).pathname, app, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: app });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: app });

const fixture = JSON.parse(readFileSync(new URL("./fixtures/recipe/recipe.json", import.meta.url), "utf8"));
function draft(changes = {}) {
  const dir = mkdtempSync(join(root, "draft-"));
  mkdirSync(join(dir, "screens"));
  writeFileSync(join(dir, "screens", "home.md"), "---\nid: home\nurl: /\nspecs: smoke\n---\n첫 화면이다.\n");
  const recipe = {
    ...fixture,
    app: { kind: "web", root: "." },
    install: ["true"],
    start: { command: "exec node server.mjs {port}", ready: "/", timeoutSec: 10 },
    checks: [{ name: "Lint", command: "true", stage: "fast" }],
    e2e: { cwd: ".", dir: "e2e", playwright: `node ${join(app, "fake-playwright.mjs")}`, project: "chromium" },
    ...changes,
  };
  writeFileSync(join(dir, "recipe.json"), JSON.stringify(recipe));
  return dir;
}

test("a failing install stops at the install stage", async () => {
  const r = await verifyRecipe(draft({ install: ["exit 3"] }), app);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "install");
});

test("an app that never answers its ready address stops at the start stage", async () => {
  const r = await verifyRecipe(draft({ start: { command: "exec sleep 29", ready: "/", timeoutSec: 2 } }), app);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "start");
});

test("a screen that lands on the login page fails the screens stage", async () => {
  process.env.FIXTURE_LOGIN_REDIRECT = "1";
  const login = { kind: "form", account: { url: "/login", user: "a@b.test", password: "pw" }, initPage: "recipe:login.mjs" };
  const dir = draft({ login });
  writeFileSync(join(dir, "login.mjs"), "export default async () => {};\n");
  const r = await verifyRecipe(dir, app);
  delete process.env.FIXTURE_LOGIN_REDIRECT;
  assert.equal(r.ok, false);
  assert.equal(r.stage, "screens");
  assert.match(r.error, /home.*로그인/);
});

test("a recipe that installs, starts, shows its screens and passes its checks is verified", async () => {
  const r = await verifyRecipe(draft(), app);
  assert.equal(r.error, "");
  assert.equal(r.ok, true);
  assert.equal(r.shots.length, 1);
  assert.ok(existsSync(r.shots[0]));
});

test("a draft that changes the checks waits for the human; approving promotes it and keeps the old one", () => {
  cpSync(draft(), paths.recipe, { recursive: true });
  cpSync(draft({ checks: [{ name: "x", command: "true", stage: "fast" }] }), paths.recipeDraft, { recursive: true });
  assert.deepEqual(promoteDraft(), { promoted: false, gate: ["checks"] });
  assert.deepEqual(readRecipeState().awaitingApproval, ["checks"]);
  assert.deepEqual(promoteDraft({ approved: true }), { promoted: true, gate: ["checks"] });
  assert.equal(JSON.parse(readFileSync(join(paths.recipe, "recipe.json"), "utf8")).checks[0].name, "x");
  assert.equal(readRecipeState().awaitingApproval, null);
  assert.ok(existsSync(paths.recipeHistory));
});

test("watch promotes a clean repair at once and tells the human once about a failure or an approval", async () => {
  const { followRecipe } = await import("../lib/bootstrap.mjs");
  const { writeJson } = await import("../lib/store.mjs");
  const told = [];
  const notify = async (text) => told.push(text);
  cpSync(draft({ seed: ["true"], checks: [{ name: "x", command: "true", stage: "fast" }] }), paths.recipeDraft, { recursive: true });
  writeJson(paths.recipeState, { phase: "repair", stage: "ready" });
  await followRecipe({ notify });
  assert.equal(readRecipeState().stage, "promoted");
  assert.deepEqual(JSON.parse(readFileSync(join(paths.recipe, "recipe.json"), "utf8")).seed, ["true"]);
  assert.match(told.at(-1), /실행 지침을 수리했습니다/);

  writeJson(paths.recipeState, { phase: "repair", stage: "failed", error: "install 실패" });
  await followRecipe({ notify });
  await followRecipe({ notify });
  assert.equal(told.filter((t) => /실행 지침 수리 실패/.test(t)).length, 1);
});

test("a failed bootstrap keeps the stage it failed at", async () => {
  const { finishState } = await import("../lib/bootstrap.mjs");
  assert.deepEqual(finishState({ ok: false, error: "e" }, "screens"), { stage: "failed", failedStage: "screens", error: "e", realKeys: [], needsE2eSetup: false, e2eSetup: null });
  assert.equal(finishState({ ok: true }, "checks").failedStage, null);
});

test("a draft with a symlink is refused before anything is copied", async () => {
  const { symlinkSync } = await import("node:fs");
  const dir = draft();
  rmSync(paths.recipeDraft, { recursive: true, force: true });
  cpSync(dir, paths.recipeDraft, { recursive: true });
  symlinkSync(join(dir, "recipe.json"), join(paths.recipeDraft, "screens", "link.md"));
  assert.throws(() => promoteDraft({ approved: true }), /링크나 특수 파일/);
});

test("a draft for another repo than the one chosen is refused", () => {
  rmSync(paths.recipeDraft, { recursive: true, force: true });
  cpSync(draft({ repo: "acme/upstream" }), paths.recipeDraft, { recursive: true });
  assert.throws(() => promoteDraft({ approved: true, repo: "acme/shop" }), /acme\/upstream.*acme\/shop/);
});

test("approving checks the draft is the one the human saw", async () => {
  const { draftHash } = await import("../lib/bootstrap.mjs");
  rmSync(paths.recipeDraft, { recursive: true, force: true });
  cpSync(draft({ seed: ["a"] }), paths.recipeDraft, { recursive: true });
  const seen = draftHash();
  writeFileSync(join(paths.recipeDraft, "env"), "CHANGED=1\n");
  assert.throws(() => promoteDraft({ approved: true, hash: seen }), /보신 뒤에 바뀌었습니다/);
  assert.equal(promoteDraft({ approved: true, hash: draftHash() }).promoted, true);
});

test("with no recipe yet, the demo has no CDP target and stopping it does nothing", async () => {
  const { demoCdp, stopDemo } = await import("../lib/demo.mjs");
  const { withRecipe } = await import("../lib/recipe.mjs");
  const empty = mkdtempSync(join(root, "empty-"));
  await withRecipe(empty, async () => {
    assert.equal(demoCdp(), null);
    assert.equal(stopDemo(), null);
  });
});

test("a first bootstrap whose session fails ends as failed, not stuck at the session", async () => {
  const { bootstrap } = await import("../lib/bootstrap.mjs");
  // The agent's clone: a repo whose origin has one commit.
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: origin });
  execFileSync("git", ["clone", "-q", origin, paths.repo]);
  rmSync(paths.recipe, { recursive: true, force: true });
  const r = await bootstrap({ repo: "acme/shop", base: "main", session: async () => { throw new Error("session boom"); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /session boom/);
  assert.equal(readRecipeState().stage, "failed");
});

test("the draft names the repo the installer chose, whatever the session wrote", async () => {
  const { bootstrap } = await import("../lib/bootstrap.mjs");
  const written = draft({ repo: "acme/upstream", install: ["exit 1"] });
  const session = async () => {
    cpSync(written, paths.recipeDraft, { recursive: true });
    return { ok: true, json: { status: "ok", reason: "", realKeys: [], needsE2eSetup: false, e2eSetup: { title: "", spec: "" }, evidence: "" } };
  };
  const r = await bootstrap({ repo: "acme/shop", base: "main", session });
  assert.equal(r.ok, false);
  assert.equal(JSON.parse(readFileSync(join(paths.recipeDraft, "recipe.json"), "utf8")).repo, "acme/shop");
});

test("the setup page sees when the bootstrap began, when its stage began and what the session does", async () => {
  const { bootstrap } = await import("../lib/bootstrap.mjs");
  const written = draft({ install: ["exit 1"] });
  let during = null;
  const session = async ({ onActivity }) => {
    onActivity("명령 실행: npm ci");
    during ??= readRecipeState();
    cpSync(written, paths.recipeDraft, { recursive: true });
    return { ok: true, json: { status: "ok", reason: "", realKeys: [], needsE2eSetup: false, e2eSetup: { title: "", spec: "" }, evidence: "" } };
  };
  await bootstrap({ repo: "acme/shop", base: "main", session });
  assert.equal(during.activity.text, "명령 실행: npm ci");
  assert.ok(Date.parse(during.startedAt) <= Date.parse(during.stageAt));
  const after = readRecipeState();
  assert.equal(after.startedAt, during.startedAt);
  // The runner's own stages show their name, not the session's last command.
  assert.equal(after.activity, null);
});

test("verification restarts the app even when one is already running on the port", async () => {
  const { spawn } = await import("node:child_process");
  const stray = spawn("sleep", ["28"], { detached: true, stdio: "ignore" });
  writeFileSync(join(process.env.FIELDTEST_DATA, "run", `demo-${process.env.FIELDTEST_DEMO_PORT}.pid`), String(stray.pid));
  const r = await verifyRecipe(draft({ start: { command: "exec sleep 27", ready: "/", timeoutSec: 2 } }), app);
  assert.equal(r.stage, "start");
});

test("the promoted recipe and its history are read-only for the agent's group", async () => {
  const { statSync } = await import("node:fs");
  const old = process.umask(0o002);
  rmSync(paths.recipeDraft, { recursive: true, force: true });
  cpSync(draft({ seed: ["b"] }), paths.recipeDraft, { recursive: true });
  promoteDraft({ approved: true });
  process.umask(old);
  assert.equal(statSync(join(paths.recipe, "recipe.json")).mode & 0o777, 0o644);
  for (const name of (await import("node:fs")).readdirSync(paths.recipeHistory)) assert.equal(statSync(join(paths.recipeHistory, name)).mode & 0o777, 0o755);
});

test("real keys merge into the human's key file, readable by the agent's group only", async () => {
  const { statSync } = await import("node:fs");
  const { writeSecrets } = await import("../lib/bootstrap.mjs");
  writeSecrets({ OPENAI_API_KEY: "sk-a" });
  writeSecrets({ STRIPE_KEY: "rk-b", "bad name": "x", EMPTY: " " });
  assert.equal(readFileSync(paths.recipeSecrets, "utf8"), "OPENAI_API_KEY=sk-a\nSTRIPE_KEY=rk-b\n");
  assert.equal(statSync(paths.recipeSecrets).mode & 0o777, 0o640);
});
