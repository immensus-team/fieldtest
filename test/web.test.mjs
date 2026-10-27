import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// The command queue lives under ~/.config; keep it in a temporary home.
process.env.HOME = mkdtempSync(join(tmpdir(), "uq-web-home-"));
process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-web-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { handler, redact, watchProcess } = await import("../lib/web.mjs");
const { QUEUE_DIR } = await import("../lib/slack.mjs");
const { createTicket, ticketDir } = await import("../lib/store.mjs");
const { STEPS, completeStep, invalidate } = await import("../lib/setup.mjs");
// The dashboard tests run on a finished install.
for (const step of STEPS) completeStep(step, {});

const TOKEN = "t0ken";
let server;
let port;
let woke = 0;

before(async () => {
  createTicket({ id: "QA-0001", status: "awaiting", title: "제목", severity: "low", screen: "chat", attempt: 1 });
  createTicket({ id: "QA-0002", status: "pr-review", title: "제목", severity: "low", screen: "chat", pr: { number: 9, url: "u", round: 0 } });
  mkdirSync(join(ticketDir("QA-0001"), "attempts", "1", "shots"), { recursive: true });
  writeFileSync(join(ticketDir("QA-0001"), "attempts", "1", "shots", "after-390-light.png"), "png");
  server = createServer((req, res) => handler({ token: TOKEN, wake: async () => woke++ })(req, res));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  port = server.address().port;
});
after(() => server.close());

const call = (path, { method = "GET", token, body } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(token ? { "x-fieldtest-token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

// fetch always sends the real Host, so this one goes through node:http.
const statusWithHost = (host) =>
  new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/session", headers: { host } }, (res) => {
      res.resume();
      ok(res.statusCode);
    });
    req.on("error", fail);
    req.end();
  });

test("another Host is refused (DNS rebinding)", async () => {
  assert.equal(await statusWithHost(`evil.test:${port}`), 421);
  assert.equal(await statusWithHost(`localhost:${port}`), 200);
});

test("a POST without the session token is refused", async () => {
  const r = await call("/api/tickets/QA-0001/commands", { method: "POST", body: { verb: "승인" } });
  assert.equal(r.status, 403);
  assert.equal((await (await call("/api/session")).json()).token, TOKEN);
});

test("an allowed command is queued for watch; a disallowed one gets the reason", async () => {
  const empty = await call("/api/tickets/QA-0001/commands", { method: "POST", token: TOKEN, body: { verb: "거절" } });
  assert.equal(empty.status, 409);
  const ok = await call("/api/tickets/QA-0001/commands", { method: "POST", token: TOKEN, body: { verb: "승인" } });
  assert.equal(ok.status, 202);
  assert.equal(woke, 1);
  const files = readdirSync(QUEUE_DIR);
  assert.equal(files.length, 1);
  const item = JSON.parse(readFileSync(join(QUEUE_DIR, files[0]), "utf8"));
  assert.equal(item.id, "QA-0001");
  assert.equal(item.verb, "승인");
  assert.equal(item.source, "web");

  const no = await call("/api/tickets/QA-0002/commands", { method: "POST", token: TOKEN, body: { verb: "머지" } });
  assert.equal(no.status, 409);
  assert.match((await no.json()).error, /최종 검토/);
  const again = await call("/api/tickets/QA-0001/commands", { method: "POST", token: TOKEN, body: { verb: "승인" } });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /처리 대기/);
  assert.equal((await call("/api/tickets/QA-0001/commands", { method: "POST", token: TOKEN, body: { verb: "삭제" } })).status, 400);
});

test("queued commands show as waiting until watch records them", async () => {
  const list = await (await call("/api/commands")).json();
  assert.equal(list[0].id, "QA-0001");
  assert.equal(list[0].ok, null);
  assert.equal(list[0].message, "watch 처리 대기");
  const [file] = readdirSync(QUEUE_DIR);
  renameSync(join(QUEUE_DIR, file), join(QUEUE_DIR, `${file}.running`));
  const running = await (await call("/api/commands")).json();
  assert.equal(running[0].message, "watch 처리 중");
});

test("files are served only from inside the ticket directory", async () => {
  const shot = await call("/api/files/QA-0001/attempts/1/shots/after-390-light.png");
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/png");
  assert.equal((await call("/api/files/QA-0001/..%2F..%2Fstate.json")).status, 404);
  assert.equal((await call("/api/files/QA-0001/status.json")).status, 404);
});

test("ticket detail lists its attempts and shots", async () => {
  const d = await (await call("/api/tickets/QA-0001")).json();
  assert.equal(d.card.id, "QA-0001");
  // The 승인 queued above is still waiting for watch.
  assert.deepEqual(d.card.actions, []);
  assert.equal(d.card.stage, "승인 요청 접수됨");
  assert.equal(d.card.progress.detail, "watch 처리 중");
  assert.equal(d.shots[0].after, "/api/files/QA-0001/attempts/1/shots/after-390-light.png");
  assert.equal((await call("/api/tickets/QA-0099")).status, 404);
});

test("tokens are masked", () => {
  assert.equal(redact("Bearer xoxb-123-abc ok"), "Bearer [가림] ok");
  assert.equal(redact("ghp_abcdefghijklmnopqrstuvwxyz0123"), "[가림]");
});

test("the explore tab lists findings and explorations, and a session's steps carry their judgment", async () => {
  const { paths } = await import("../lib/config.mjs");
  const { writeJson } = await import("../lib/store.mjs");
  const { createFinding } = await import("../lib/findings.mjs");
  const dir = join(paths.sessions, "1792700000000");
  mkdirSync(join(dir, "shots"), { recursive: true });
  writeFileSync(join(dir, "shots", "step-2.png"), "png");
  writeJson(join(dir, "session.json"), { at: "2026-10-22T10:00:00.000Z", status: "done", goal: "지난달 매출 정리", steps: 2, mismatched: 1, verdicts: { defect: 1 }, findings: ["F-0001"] });
  writeJson(join(dir, "use.json"), { steps: [{ n: 1, matched: true, screenshot: "" }, { n: 2, matched: false, screenshot: "step-2.png" }] });
  writeJson(join(dir, "judge.json"), { judgments: [{ steps: [2], verdict: "defect", reason: "재현됨", duplicateOf: "" }] });
  createFinding({ session: "1792700000000", area: "usage", severity: "medium", title: "표가 비어 있다" });

  const info = await (await call("/api/explore")).json();
  assert.equal(info.findings[0].id, "F-0001");
  assert.equal(info.sessions[0].goal, "지난달 매출 정리");
  const detail = await (await call("/api/sessions/1792700000000")).json();
  assert.equal(detail.steps[1].verdict, "defect");
  assert.equal(detail.steps[1].shot, "/api/sessions/1792700000000/files/shots/step-2.png");
  assert.equal(detail.steps[0].verdict, null);
  assert.equal((await call(detail.steps[1].shot)).status, 200);
  assert.equal((await call("/api/sessions/1792700000000/files/shots/..%2F..%2Fsession.json")).status, 404);
  assert.equal((await call("/api/sessions/1")).status, 404);
});

test("a watch run in progress is live however long it takes; between runs an old last run is stale", () => {
  const at = Date.parse("2026-10-23T06:30:00Z");
  const ws = { startedAt: "2026-10-23T06:21:30Z", ranAt: "2026-10-23T06:20:30Z" };
  assert.deepEqual(watchProcess(ws, true, at), { name: "watch", lastAt: ws.ranAt, runningSince: ws.startedAt, stale: false });
  assert.equal(watchProcess(ws, false, at).stale, true);
  assert.equal(watchProcess({ ranAt: "2026-10-23T06:29:00Z" }, false, at).stale, false);
  assert.equal(watchProcess({}, false, at).stale, true);
});

test("before setup finishes, the dashboard API answers 409 and the wizard state is served", async () => {
  invalidate("start");
  const overview = await call("/api/overview");
  assert.equal(overview.status, 409);
  assert.deepEqual(await overview.json(), { setup: true });
  const state = await (await call("/api/setup/state")).json();
  assert.equal(state.current, "start");
  assert.equal(state.steps.server.done, true);
  completeStep("start", {});
  assert.equal((await call("/api/overview")).status, 200);
});

test("reopening a step needs the session token and voids the steps after it", async () => {
  assert.equal((await call("/api/setup/step/repo/reopen", { method: "POST" })).status, 403);
  const r = await call("/api/setup/step/repo/reopen", { method: "POST", token: TOKEN });
  assert.equal(r.status, 200);
  const state = await (await call("/api/setup/state")).json();
  assert.equal(state.current, "repo");
  assert.equal(state.steps.bootstrap.done, false);
  for (const step of STEPS) completeStep(step, {});
});

test("the recipe step reads the draft's screens before any recipe is approved", async () => {
  const { paths } = await import("../lib/config.mjs");
  const { cpSync, rmSync } = await import("node:fs");
  rmSync(paths.recipe, { recursive: true, force: true });
  cpSync(new URL("./fixtures/recipe", import.meta.url).pathname, paths.recipeDraft, { recursive: true });
  const r = await call("/api/setup/recipe");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.repo, "acme/shop");
  assert.ok(body.screens.some((s) => s.id === "usage"));
});

test("any local port is allowed, other host names are not", async () => {
  const { allowedHost } = await import("../lib/web.mjs");
  assert.equal(allowedHost("127.0.0.1:4311"), true);
  assert.equal(allowedHost("localhost"), true);
  assert.equal(allowedHost("evil.test:4310"), false);
  assert.equal(allowedHost("127.0.0.1.evil.test"), false);
});

test("reopening the repo step drops the old recipe, its draft and the bootstrap state", async () => {
  const { paths } = await import("../lib/config.mjs");
  const { cpSync, existsSync, mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const fixture = new URL("./fixtures/recipe", import.meta.url).pathname;
  cpSync(fixture, paths.recipe, { recursive: true });
  cpSync(fixture, paths.recipeDraft, { recursive: true });
  mk(join(paths.recipeState, ".."), { recursive: true });
  wf(paths.recipeState, JSON.stringify({ stage: "ready", phase: "bootstrap" }));
  const r = await call("/api/setup/step/repo/reopen", { method: "POST", token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(existsSync(join(paths.recipe, "recipe.json")), false);
  assert.equal(existsSync(paths.recipeDraft), false);
  assert.deepEqual(JSON.parse(readFileSync(paths.recipeState, "utf8")), {});
  for (const step of STEPS) completeStep(step, {});
});

test("skipping Slack finishes its step without tokens", async () => {
  invalidate("slack");
  assert.equal((await call("/api/setup/slack/skip", { method: "POST" })).status, 403);
  const r = await call("/api/setup/slack/skip", { method: "POST", token: TOKEN });
  assert.equal(r.status, 200);
  const state = await (await call("/api/setup/state")).json();
  assert.equal(state.steps.slack.done, true);
  assert.equal(state.steps.slack.info.skipped, true);
  assert.equal(state.current, "start");
  for (const step of STEPS) completeStep(step, {});
});

test("auto-merge is read and switched from the dashboard with the session token", async () => {
  const { AUTO_ROUTE } = await import("../lib/bootstrap.mjs");
  // An earlier test reopened the repo step, which drops the approved recipe.
  useFixtureRecipe();
  assert.equal((await call("/api/settings/auto-merge", { method: "POST", body: { on: true } })).status, 403);
  const on = await call("/api/settings/auto-merge", { method: "POST", token: TOKEN, body: { on: true } });
  assert.equal(on.status, 200);
  assert.deepEqual(await (await call("/api/settings")).json(), { autoRoute: AUTO_ROUTE, rule: AUTO_ROUTE });
  await call("/api/settings/auto-merge", { method: "POST", token: TOKEN, body: { on: false } });
  assert.equal((await (await call("/api/settings")).json()).autoRoute, null);
  assert.equal((await call("/api/settings/auto-merge", { method: "POST", token: TOKEN, body: { on: "yes" } })).status, 400);
});
