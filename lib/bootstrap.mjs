// Bootstrap and repair of the recipe (design §8). A Claude session reads the target repo and writes a
// draft; the runner runs the draft end to end; only the human account promotes it (§7.2).
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { TIMEOUTS, TOOL_DIR, paths, settings } from "./config.mjs";
import { demoCdp, demoUrl, loginInit, startDemo, stopDemo } from "./demo.mjs";
import { loadSchema, renderPrompt, runClaude } from "./engines.mjs";
import { gitOut } from "./exec.mjs";
import { e2e, install, parseTestList, playwright, repoCheck, tailOf } from "./gate.mjs";
import { loadRecipe, recipeChanges, recipeScreensDir, withRecipe } from "./recipe.mjs";
import { loadScreens } from "./screens.mjs";
import { readJson, writeJson } from "./store.mjs";
import { addWorktree, fetchOrigin, removeWorktree } from "./worktree.mjs";

export const STAGES = ["install", "services", "seed", "start", "screens", "checks"];
export const MAX_BOOTSTRAP_FIXES = 5;
export const BOOTSTRAP_MS = 120 * 60 * 1000;

const now = () => new Date().toISOString();
const tailText = (file) => (existsSync(file) ? readFileSync(file, "utf8").slice(-3000) : "");

// Opens every screen of the guide in the app's own Playwright, with the recipe's login, and keeps a
// screenshot of each. A screen that ends on the login address or shows no text fails.
async function checkScreens(wt, recipe, logFile) {
  const dir = join(wt, recipe.e2e.cwd, ".fieldtest-check");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shotsDir = join(recipe.dir, "shots");
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const screens = loadScreens(recipeScreensDir(recipe)).map((s) => ({ id: s.id, url: s.url }));
  const results = join(dir, "results.json");
  const init = await loginInit(wt, dir, recipe);
  writeFileSync(join(dir, "screen-check.json"), JSON.stringify({ screens, results, shotsDir, baseURL: demoUrl(), cdp: demoCdp(recipe) }));
  writeFileSync(
    join(dir, "screen-check.spec.mjs"),
    recipe.app.kind === "electron"
      ? // An Electron app shows its own windows: attach over CDP and check the first one has content.
        `import { readFileSync, writeFileSync } from "node:fs";
import { chromium, test } from "@playwright/test";
const check = JSON.parse(readFileSync(new URL("./screen-check.json", import.meta.url), "utf8"));
test("windows", async () => {
  const browser = await chromium.connectOverCDP(check.cdp);
  const page = browser.contexts().flatMap((c) => c.pages())[0];
  const out = [];
  for (const s of check.screens) {
    const shot = \`\${check.shotsDir}/\${s.id}.png\`;
    if (page) await page.screenshot({ path: shot });
    out.push({ id: s.id, finalUrl: page?.url() ?? "about:blank", textLength: page ? (await page.locator("body").innerText()).trim().length : 0, shot });
  }
  writeFileSync(check.results, JSON.stringify(out));
});
`
      : `import { readFileSync, writeFileSync } from "node:fs";
import { test } from "@playwright/test";
${init ? `import login from ${JSON.stringify(pathToFileURL(init).href)};` : "const login = async () => {};"}
const check = JSON.parse(readFileSync(new URL("./screen-check.json", import.meta.url), "utf8"));
const out = [];
test.afterAll(() => writeFileSync(check.results, JSON.stringify(out)));
for (const s of check.screens) {
  test(s.id, async ({ page }) => {
    await login({ page });
    await page.goto(s.url);
    await page.waitForLoadState("networkidle").catch(() => {});
    const shot = \`\${check.shotsDir}/\${s.id}.png\`;
    await page.screenshot({ path: shot });
    out.push({ id: s.id, finalUrl: page.url(), textLength: (await page.locator("body").innerText()).trim().length, shot });
  });
}
`,
  );
  writeFileSync(
    join(dir, "playwright.config.mjs"),
    `export default ${JSON.stringify({ testDir: ".", testMatch: "screen-check.spec.mjs", workers: 1, reporter: "line", use: { baseURL: demoUrl() }, projects: [{ name: recipe.e2e.project, use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } }] })};\n`,
  );
  await playwright(wt, [`--config=${relative(join(wt, recipe.e2e.cwd), join(dir, "playwright.config.mjs"))}`], logFile, TIMEOUTS.e2e);
  const seen = readJson(results, []);
  rmSync(dir, { recursive: true, force: true });
  const loginPath = recipe.login.account?.url;
  const problems = screens.flatMap((s) => {
    const r = seen.find((x) => x.id === s.id);
    if (!r) return [`${s.id}: 화면을 열지 못했다`];
    if (loginPath && r.finalUrl.startsWith("http") && new URL(r.finalUrl).pathname === loginPath && s.url !== loginPath) return [`${s.id}: 로그인 화면(${loginPath})으로 이동했다`];
    if (!r.textLength) return [`${s.id}: 글자가 없는 빈 화면이다`];
    return [];
  });
  return { problems, shots: seen.map((r) => r.shot) };
}

// Runs a draft (or any recipe directory) in `wt`: install, services and seed, start, screens, checks.
// { ok, stage, error, shots }: stage and error name the first step that failed.
export function verifyRecipe(dir, wt, { logFile = join(dir, "verify.log"), onStage = () => {}, needsE2eSetup = false } = {}) {
  return withRecipe(dir, async () => {
    let shots = [];
    const fail = (stage, error) => ({ ok: false, stage, error, shots });
    let recipe;
    try {
      recipe = loadRecipe(dir);
    } catch (e) {
      return fail("recipe", e.message);
    }
    onStage("install");
    const inst = await install(wt, logFile);
    if (inst.code !== 0) return fail("install", tailOf(inst));
    onStage("services");
    // An app a session left running would answer for this draft and skip services, seed and start.
    stopDemo();
    const up = await startDemo(wt);
    if (!up.ok) return fail(up.stage, tailText(up.log));
    try {
      onStage("screens");
      const seen = await checkScreens(wt, recipe, logFile);
      shots = seen.shots;
      if (seen.problems.length) return fail("screens", seen.problems.join("\n"));
    } finally {
      stopDemo();
    }
    onStage("checks");
    for (const check of recipe.checks) {
      const r = await repoCheck(wt, check, logFile);
      if (r.code !== 0) return fail("checks", `${check.name} 실패\n${tailOf(r)}`);
    }
    if (!needsE2eSetup) {
      const listed = parseTestList((await playwright(wt, ["--list"], logFile, TIMEOUTS.install)).stdout ?? "");
      if (!listed.length) return fail("checks", `${recipe.e2e.dir}에서 e2e test를 찾지 못했다`);
      const first = listed[0];
      const r = await e2e(wt, [`${recipe.e2e.dir.replace(/\/+$/, "")}/${first.file}:${first.line}`], logFile);
      if (r.code !== 0) return fail("checks", `e2e ${first.file} 실패\n${tailOf(r)}`);
    }
    return { ok: true, stage: null, error: "", shots };
  });
}

export const readRecipeState = () => readJson(paths.recipeState, {});

function record(change) {
  mkdirSync(join(paths.recipeState, ".."), { recursive: true });
  writeJson(paths.recipeState, { ...readRecipeState(), ...change, at: now() });
}

// One bootstrap (no approved recipe yet) or repair (feedback says what broke). Sessions write the
// draft; the runner verifies it and feeds the failure back, up to MAX_BOOTSTRAP_FIXES times within
// BOOTSTRAP_MS. The repo and base branch come from the installer's choice (or the approved recipe),
// never from the session. Keys in skipKeys were declined: the session mocks what needs them.
// Returns { ok, realKeys, needsE2eSetup, e2eSetup, error }; any failure ends in recipe-state "failed".
export async function bootstrap({ feedback = null, repo = null, base = null, skipKeys = [], session = runClaude } = {}) {
  const prev = existsSync(join(paths.recipe, "recipe.json")) ? loadRecipe(paths.recipe) : null;
  const target = { repo: repo ?? prev?.repo, baseBranch: base ?? prev?.baseBranch };
  const phase = prev ? "repair" : "bootstrap";
  const until = Date.now() + BOOTSTRAP_MS;
  const work = join(paths.runs, "bootstrap", String(Date.now()));
  mkdirSync(work, { recursive: true });
  const logFile = join(work, "run.log");
  let stage = "session";
  let wt = null;
  const finish = (result) => {
    record(finishState(result, stage));
    return { realKeys: [], needsE2eSetup: false, e2eSetup: null, ...result };
  };
  // startedAt and stageAt give the setup page its clocks; activity is the session's latest step.
  const enter = (s) => record({ stage: (stage = s), stageAt: now(), activity: null });
  record({ phase, stage, stageAt: now(), startedAt: now(), activity: null, attempt: 1, error: null, awaitingApproval: null, repair: null, failedStage: null, notified: null });
  try {
    if (!target.repo || !target.baseBranch) throw new Error("검사할 레포와 기본 branch를 모릅니다. 설치 마법사에서 레포를 다시 고르세요.");
    rmSync(paths.recipeDraft, { recursive: true, force: true });
    if (prev) cpSync(paths.recipe, paths.recipeDraft, { recursive: true });
    else mkdirSync(paths.recipeDraft, { recursive: true });
    await fetchOrigin();
    wt = await addWorktree("bootstrap", await gitOut(paths.repo, ["rev-parse", `origin/${target.baseBranch}`]));
    let note = feedback;
    for (let attempt = 1; attempt <= MAX_BOOTSTRAP_FIXES && Date.now() < until; attempt++) {
      record({ attempt });
      enter("session");
      const res = await withRecipe(paths.recipeDraft, () =>
        session({
          cwd: wt,
          prompt: renderPrompt("bootstrap", {
            toolDir: TOOL_DIR,
            draftDir: paths.recipeDraft,
            demoUrl: demoUrl(),
            workDir: work,
            guideDocs: "AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README 중 있는 것",
            mode: prev ? "수리" : "처음 만들기",
            repo: target.repo,
            baseBranch: target.baseBranch,
            feedback: note ? `## 고칠 것\n\n${note}` : "",
            secrets: secretNames().join(", ") || "없음",
            declined: skipKeys.join(", ") || "없음",
          }),
          schema: loadSchema("bootstrap"),
          model: settings().implementModel,
          shotsDir: join(work, `shots-${attempt}`),
          logFile,
          timeoutMs: Math.max(60_000, until - Date.now()),
          onActivity: (text) => record({ activity: { text, at: now() } }),
        }),
      );
      if (!res.ok) return finish({ ok: false, error: res.error });
      const out = res.json;
      writeJson(join(work, `session-${attempt}.json`), out);
      if (out.status === "blocked") return finish({ ok: false, error: `레시피를 만들 수 없다: ${out.reason}` });
      pinTarget(target);
      const missing = out.realKeys.filter((k) => !skipKeys.includes(k.name) && !secretNames().includes(k.name));
      if (missing.length) return finish({ ok: false, realKeys: missing, error: "실제 키가 필요하다" });
      const v = await verifyRecipe(paths.recipeDraft, wt, { logFile, needsE2eSetup: out.needsE2eSetup, onStage: enter });
      if (v.ok) return finish({ ok: true, needsE2eSetup: out.needsE2eSetup, e2eSetup: out.e2eSetup });
      note = `검증 단계 \`${v.stage}\`가 실패했다.\n\n\`\`\`\n${v.error}\n\`\`\``;
      record({ error: note });
    }
    return finish({ ok: false, error: `수정 ${MAX_BOOTSTRAP_FIXES}회 또는 ${BOOTSTRAP_MS / 60000}분 안에 검증을 통과하지 못했다.\n\n${note ?? ""}` });
  } catch (e) {
    return finish({ ok: false, error: e.message });
  } finally {
    if (wt) await removeWorktree(wt).catch(() => {});
  }
}

const secretNames = () => (existsSync(paths.recipeSecrets) ? readFileSync(paths.recipeSecrets, "utf8").split("\n").map((l) => l.split("=")[0].trim()).filter(Boolean) : []);

// The draft names the repo and branch the installer chose, whatever the session wrote: a fork's README
// naming its upstream must not send PRs there.
function pinTarget(target) {
  const file = join(paths.recipeDraft, "recipe.json");
  if (!existsSync(file)) return;
  const r = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...r, repo: target.repo, baseBranch: target.baseBranch }, null, 2));
}

// The state a finished bootstrap leaves; a failure keeps the stage it stopped at for the setup page.
export function finishState(result, stage) {
  return {
    stage: result.ok ? "ready" : "failed",
    failedStage: result.ok ? null : stage,
    error: result.error ?? null,
    realKeys: result.realKeys ?? [],
    needsE2eSetup: Boolean(result.needsE2eSetup),
    e2eSetup: result.e2eSetup ?? null,
  };
}

// Every regular file of the draft by relative path. Links and special files are refused: the human
// copies the agent's draft, and a link would let the agent edit the approved copy later.
function draftFiles(dir = paths.recipeDraft, rel = "") {
  const out = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = join(rel, name);
    const st = lstatSync(join(dir, path));
    if (st.isDirectory()) out.push(...draftFiles(dir, path));
    else if (st.isFile()) out.push(path);
    else throw new Error(`레시피 초안에 링크나 특수 파일이 있습니다: ${path}`);
  }
  return out;
}

// What the human saw: the setup page and the CLI show it, and approving checks it again.
export function draftHash() {
  const h = createHash("sha256");
  for (const f of draftFiles()) h.update(`${f}\0`).update(readFileSync(join(paths.recipeDraft, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}

// Human account (watch, the setup page or the CLI). The first recipe is promoted only when the
// installer approves it; a repair that leaves the gate keys alone is promoted at once, one that changes
// them waits for the human. The draft must be for the repo the installer chose.
export function promoteDraft({ approved = false, hash = null, repo = null } = {}) {
  const files = draftFiles();
  if (hash && hash !== draftHash()) throw new Error("레시피 초안이 보신 뒤에 바뀌었습니다. 다시 보고 승인하세요.");
  const draft = loadRecipe(paths.recipeDraft);
  const prevFile = join(paths.recipe, "recipe.json");
  const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, "utf8")) : null;
  const expected = repo ?? prev?.repo;
  if (expected && draft.repo !== expected) throw new Error(`레시피 초안의 레포(${draft.repo})가 고른 레포(${expected})와 다릅니다.`);
  const { gate } = prev ? recipeChanges(prev, draft) : { gate: [] };
  if ((!prev || gate.length) && !approved) {
    record({ awaitingApproval: prev ? gate : ["처음 레시피"] });
    return { promoted: false, gate };
  }
  // Built next to the approved recipe and swapped in by renames, so a lane never finds it missing.
  const next = `${paths.recipe}.next`;
  rmSync(next, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(next, f)), { recursive: true });
    writeFileSync(join(next, f), readFileSync(join(paths.recipeDraft, f)));
  }
  lockDown(next);
  loadRecipe(next);
  if (prev) {
    mkdirSync(paths.recipeHistory, { recursive: true });
    renameSync(paths.recipe, join(paths.recipeHistory, now().replace(/[:.]/g, "-")));
  }
  renameSync(next, paths.recipe);
  record({ awaitingApproval: null, promotedAt: now() });
  return { promoted: true, gate };
}

// The approved recipe is the human's: readable by the agent, writable by nobody else.
function lockDown(dir) {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) lockDown(p);
    else chmodSync(p, 0o644);
  }
}
// watch (human account), every run: a finished repair is promoted when it leaves the gate alone; the
// human hears once of a repair that waits for approval or failed.
export async function followRecipe({ notify }) {
  const state = readRecipeState();
  const once = async (key, text) => {
    if (state.notified === key) return;
    await notify(text);
    // Not through record(): the key names the state's own time, which record() would move.
    writeJson(paths.recipeState, { ...readRecipeState(), notified: key });
  };
  if (state.phase === "repair" && state.stage === "ready" && !state.awaitingApproval?.length) {
    const r = promoteDraft();
    if (r.promoted) {
      record({ stage: "promoted" });
      await notify("레시피를 수리했습니다. 다음 탐색부터 새 레시피를 씁니다.");
    } else await once(`approval:${state.at}`, `레시피 수리가 게이트 항목(${r.gate.join(", ")})을 바꿨습니다. 서버에서 fieldtest recipe show로 변경과 hash를 보고, fieldtest recipe approve --hash <hash>로 승인해야 탐색을 다시 시작합니다.`);
  }
  if (state.stage === "failed") await once(`failed:${state.at}`, `레시피 수리 실패. 탐색을 멈췄습니다. 원인을 고친 뒤 서버에서 fieldtest recipe repair로 다시 수리합니다(필요한 키는 fieldtest recipe key <이름>).\n${String(state.error ?? "").slice(0, 1500)}`);
}

// Real keys the installer gives (setup page or CLI), merged into the human's key file: the agent reads
// it through the staff group, nobody else does.
export function writeSecrets(values) {
  mkdirSync(dirname(paths.recipeSecrets), { recursive: true });
  const now = existsSync(paths.recipeSecrets) ? readFileSync(paths.recipeSecrets, "utf8") : "";
  const env = Object.fromEntries(now.split("\n").map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  for (const [k, v] of Object.entries(values)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string" && v.trim()) env[k] = v.trim();
  writeFileSync(paths.recipeSecrets, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o640 });
  chmodSync(paths.recipeSecrets, 0o640);
}

// Another repo, GitHub account or Claude login: the old recipe, its draft and the bootstrap state no
// longer apply (setup wizard, human account).
export function resetRecipe() {
  rmSync(paths.recipe, { recursive: true, force: true });
  rmSync(paths.recipeDraft, { recursive: true, force: true });
  mkdirSync(dirname(paths.recipeState), { recursive: true });
  writeJson(paths.recipeState, {});
}

// Asks the loop for a repair; the exploration lane runs it next (design §8.4).
export function requestRepair(reason) {
  record({ repair: { reason, at: now() } });
}
