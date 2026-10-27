// The setup wizard's API (design §5): /api/setup/*. Runs in `fieldtest web` as the human account; the
// agent's logins and the bootstrap run through `sudo -n -u <agent>` like the loop does.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { draftHash, promoteDraft, readRecipeState, resetRecipe, writeSecrets } from "./bootstrap.mjs";
import { CONFIG_DIR, DATA_DIR, INSTALL, TOOL_DIR, paths } from "./config.mjs";
import { loginStatus, sendLoginCode, startLogin } from "./device.mjs";
import { run } from "./exec.mjs";
import { loadRecipe, withRecipe } from "./recipe.mjs";
import { loadScreens } from "./screens.mjs";
import { STEPS, completeStep, currentStep, invalidate, readSetup } from "./setup.mjs";
import { manifestUrl, slackManifest } from "./slack.mjs";
import { redact } from "./web.mjs";

const MIN_FREE_GB = 20;
// Reopening these makes the recipe stale: it was made for another repo, account or Claude login.
const VOIDS_RECIPE = ["github", "repo", "claude"];
const logins = new Map();
let slackChild = null;
let bootstrapChild = null;

const ok = (body) => ({ status: 200, body });
const bad = (status, error) => ({ status, body: { error } });

const agentEnv = `PATH=${INSTALL.runtime}/node/bin:/usr/local/bin:/usr/bin:/bin`;
const asAgent = (script) => run("sudo", ["-n", "-u", INSTALL.agent, "-H", "env", agentEnv, "sh", "-c", `PATH="$HOME/.local/bin:$PATH"; export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; ${script}`]);
const firstLine = (r) => (r.stdout || r.stderr).trim().split("\n")[0];

// Step 0: what install.sh base should have left on the server.
async function serverChecks() {
  const checks = [];
  const add = (name, pass, detail = "") => checks.push({ name, ok: pass, detail });
  add("Node 24", process.versions.node.startsWith("24."), process.versions.node);
  for (const [name, script] of [
    ["Claude CLI", "claude --version"],
    ["Codex CLI", "codex --version"],
    ["Docker (rootless)", "docker info --format '{{.ServerVersion}}'"],
    ["Playwright Chromium", "ls -d $HOME/.cache/ms-playwright/chromium-* | head -1"],
  ]) {
    const r = await asAgent(script);
    add(name, r.code === 0 && r.stdout.trim() !== "", firstLine(r));
  }
  for (const [name, cmd, args] of [
    ["gh", "gh", ["--version"]],
    ["Xvfb", "sh", ["-c", "command -v xvfb-run"]],
  ]) {
    const r = await run(cmd, args);
    add(name, r.code === 0, firstLine(r));
  }
  const fs = statfsSync(DATA_DIR);
  const freeGb = Math.floor((fs.bavail * fs.bsize) / 1024 ** 3);
  add(`디스크 여유 ${MIN_FREE_GB} GB 이상`, freeGb >= MIN_FREE_GB, `${freeGb} GB`);
  return checks;
}

const slackEnvFile = join(CONFIG_DIR, "slack.env");
const slackEnv = () => (existsSync(slackEnvFile) ? Object.fromEntries(readFileSync(slackEnvFile, "utf8").split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])) : {});

function startSlackListener() {
  if (slackChild && slackChild.exitCode === null) return;
  // Only until the owner's first DM arrives; start.sh puts the long-running unit in place.
  slackChild = spawn(process.execPath, [join(TOOL_DIR, "bin", "fieldtest.mjs"), "slack"], { stdio: "ignore" });
}

// The agent runs the bootstrap for the repo the installer chose; keys the installer declined are mocked.
function startBootstrap({ feedback = null, skipKeys = [] } = {}) {
  if (bootstrapChild && bootstrapChild.exitCode === null) return false;
  const { repo, base } = readSetup().steps.repo.info;
  const log = join(paths.run, "bootstrap.log");
  mkdirSync(paths.run, { recursive: true });
  const args = ["-n", "-u", INSTALL.agent, "-H", "env", agentEnv, "sh", "-c", `PATH="$HOME/.local/bin:$PATH"; export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; set -a; . "$HOME/.config/fieldtest/env"; set +a; exec node "$0" bootstrap "$@" >> "${log}" 2>&1`, join(TOOL_DIR, "bin", "fieldtest.mjs")];
  args.push("--repo", String(repo), "--base", String(base));
  if (feedback) args.push("--feedback", feedback);
  if (skipKeys.length) args.push("--skip-keys", skipKeys.join(","));
  bootstrapChild = spawn("sudo", args, { stdio: "ignore", detached: true });
  bootstrapChild.unref();
  return true;
}

// SIGTERM makes the bootstrap stop its Claude session and exit without writing its state; waiting for
// it keeps a dying run's last write off the state reset after it.
export function stopChild(child, timeoutMs = 15_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}

function tail(file, bytes = 6000) {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  return text.slice(-bytes);
}


// Read inside the draft: before the first approval there is no recipe for screens to fall back on.
function recipeSummary() {
  return withRecipe(paths.recipeDraft, summaryOfDraft);
}

function summaryOfDraft() {
  const r = loadRecipe(paths.recipeDraft);
  const screens = loadScreens(join(r.dir, r.explore.screens)).map((s) => ({ id: s.id, url: s.url, mission: s.mission, shot: existsSync(join(r.dir, "shots", `${s.id}.png`)) ? `/api/setup/shot/${s.id}` : null }));
  return {
    hash: draftHash(),
    repo: r.repo,
    product: r.product,
    app: r.app,
    install: r.install,
    services: r.services,
    seed: r.seed ?? [],
    start: r.start,
    login: { kind: r.login.kind, user: r.login.account?.user ?? null },
    journeys: r.explore.journeys,
    checks: r.checks,
    paths: r.paths,
    screens,
  };
}

// { status, body } for JSON, { file, type } for a screenshot, or null when the path is not a setup route.
export async function setupApi(method, p, body = {}) {
  if (!p.startsWith("/api/setup/")) return null;
  const s = readSetup();
  if (method === "GET" && p === "/api/setup/state") {
    return ok({ name: INSTALL.name, steps: s.steps, current: currentStep(s), order: STEPS, recipe: readRecipeState() });
  }
  let m = p.match(/^\/api\/setup\/step\/(\w+)\/reopen$/);
  if (m && method === "POST") {
    if (!STEPS.includes(m[1])) return bad(404, "없는 단계");
    if (VOIDS_RECIPE.includes(m[1])) {
      await stopChild(bootstrapChild);
      resetRecipe();
    }
    invalidate(m[1]);
    return ok({ reopened: m[1] });
  }
  if (p === "/api/setup/server" && method === "POST") {
    const checks = await serverChecks();
    if (checks.every((c) => c.ok)) completeStep("server", { checks });
    return ok({ checks });
  }
  m = p.match(/^\/api\/setup\/(github|claude|codex)\/start$/);
  if (m && method === "POST") {
    // Codex keeps its login in the agent's home: one that is already there needs no new sign-in.
    if (m[1] === "codex" && (await asAgent("codex login status")).code === 0) {
      completeStep("codex", {});
      return ok({ id: null, done: true });
    }
    const kind = m[1] === "github" ? "gh" : m[1];
    const { id } = startLogin(kind);
    logins.set(id, m[1]);
    return ok({ id });
  }
  m = p.match(/^\/api\/setup\/login\/([0-9a-f]+)(\/code)?$/);
  if (m) {
    const step = logins.get(m[1]);
    if (!step) return bad(404, "로그인 세션이 없습니다");
    if (m[2] && method === "POST") {
      const sent = await sendLoginCode(m[1], String(body.code ?? ""));
      return sent.ok ? ok({ sent: true }) : bad(400, sent.error);
    }
    let st = await loginStatus(m[1]);
    if (st.state === "done" && step === "codex" && !s.steps.codex.done) {
      const check = await asAgent("codex login status");
      if (check.code !== 0) st = { state: "failed", error: `codex login status 실패: ${firstLine(check)}` };
    }
    if (st.state === "done" && !s.steps[step].done) {
      let info = {};
      if (step === "github") {
        await run("gh", ["auth", "setup-git"]);
        info = { login: (await run("gh", ["api", "user", "--jq", ".login"])).stdout.trim() };
      }
      invalidate(step);
      completeStep(step, info);
    }
    return ok(st);
  }
  if (p === "/api/setup/repos" && method === "GET") {
    const r = await run("gh", ["api", "--paginate", "user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed", "--jq", ".[] | {name: .full_name, private, push: .permissions.push, base: .default_branch, pushedAt: .pushed_at}"]);
    if (r.code !== 0) return bad(502, firstLine(r));
    return ok(r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  if (p === "/api/setup/repo" && method === "POST") {
    const repo = String(body.repo ?? "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return bad(400, "owner/name 형식이 아닙니다");
    const info = await run("gh", ["api", `repos/${repo}`, "--jq", "{push: .permissions.push, base: .default_branch}"]);
    if (info.code !== 0) return bad(404, `레포를 읽지 못했습니다: ${firstLine(info)}`);
    const { push, base } = JSON.parse(info.stdout);
    if (!push) return bad(403, "이 레포에 push 권한이 없습니다");
    // prepare replaces the clone a running bootstrap works in.
    await stopChild(bootstrapChild);
    const prep = await run("bash", [join(TOOL_DIR, "setup", "start.sh"), "prepare", repo], { env: { ...process.env, FIELDTEST_FROM_WEB: "1" }, timeoutMs: 30 * 60 * 1000 });
    if (prep.code !== 0) return bad(500, `미러와 clone 준비 실패: ${(prep.stderr || prep.stdout).trim().split("\n").slice(-3).join(" ")}`);
    resetRecipe();
    invalidate("repo");
    completeStep("repo", { repo, base });
    return ok({ repo, base });
  }
  if (p === "/api/setup/slack/manifest" && method === "GET") {
    const manifest = slackManifest();
    return ok({ manifest, url: manifestUrl(manifest) });
  }
  if (p === "/api/setup/slack" && method === "POST") {
    const bot = String(body.botToken ?? "").trim();
    const app = String(body.appToken ?? "").trim();
    if (!bot.startsWith("xoxb-") || !app.startsWith("xapp-")) return bad(400, "Bot token은 xoxb-, App token은 xapp-로 시작합니다");
    const auth = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${bot}` } }).then((r) => r.json());
    if (!auth.ok) return bad(400, `Bot token 확인 실패: ${auth.error}`);
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(slackEnvFile, `SLACK_BOT_TOKEN=${bot}\nSLACK_APP_TOKEN=${app}\n`, { mode: 0o600 });
    invalidate("slack");
    startSlackListener();
    return ok({ team: auth.team, bot: auth.user });
  }
  if (p === "/api/setup/slack/skip" && method === "POST") {
    slackChild?.kill();
    completeStep("slack", { skipped: true });
    return ok({ skipped: true });
  }
  if (p === "/api/setup/slack" && method === "GET") {
    const env = slackEnv();
    if (env.SLACK_USER_ID && !s.steps.slack.done) {
      completeStep("slack", { owner: env.SLACK_USER_ID });
      slackChild?.kill();
    }
    return ok({ tokens: Boolean(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN), owner: Boolean(env.SLACK_USER_ID) });
  }
  if (p === "/api/setup/bootstrap" && method === "POST") {
    invalidate("bootstrap");
    const skipKeys = Array.isArray(body.skipKeys) ? body.skipKeys.map(String).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) : [];
    return ok({ started: startBootstrap({ feedback: body.feedback ? String(body.feedback) : null, skipKeys }) });
  }
  if (p === "/api/setup/bootstrap" && method === "GET") {
    const state = readRecipeState();
    const running = Boolean(bootstrapChild && bootstrapChild.exitCode === null);
    if (state.stage === "ready" && !running && !s.steps.bootstrap.done) completeStep("bootstrap", {});
    // The session's latest command can carry a key it was given.
    if (state.activity?.text) state.activity = { ...state.activity, text: redact(state.activity.text) };
    return ok({ state, running, log: redact(tail(join(paths.run, "bootstrap.log"))) });
  }
  if (p === "/api/setup/secrets" && method === "POST") {
    writeSecrets(body.values ?? {});
    return ok({ saved: Object.keys(body.values ?? {}) });
  }
  if (p === "/api/setup/recipe" && method === "GET") return ok(recipeSummary());
  if (p === "/api/setup/recipe" && method === "POST") {
    if (body.action === "start") {
      promoteDraft({ approved: true, hash: String(body.hash ?? ""), repo: String(s.steps.repo.info.repo ?? "") || null });
      completeStep("recipe", {});
      return ok({ promoted: true });
    }
    if (body.action === "revise" && String(body.feedback ?? "").trim()) {
      invalidate("bootstrap");
      return ok({ started: startBootstrap({ feedback: String(body.feedback) }) });
    }
    return bad(400, "action은 start 또는 revise(feedback)입니다");
  }
  m = p.match(/^\/api\/setup\/shot\/([\w-]+)$/);
  if (m && method === "GET") {
    const root = resolve(paths.recipeDraft, "shots");
    const file = resolve(root, `${m[1]}.png`);
    if (!file.startsWith(root + sep) || !existsSync(file) || extname(file) !== ".png") return bad(404, "스크린샷이 없습니다");
    return { file, type: "image/png" };
  }
  if (p === "/api/setup/start" && method === "POST") {
    const r = await run("bash", [join(TOOL_DIR, "setup", "start.sh")], { env: { ...process.env, FIELDTEST_FROM_WEB: "1" }, timeoutMs: 30 * 60 * 1000 });
    if (r.code !== 0) return bad(500, `서비스 시작 실패: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
    completeStep("start", {});
    return ok({ started: true });
  }
  return bad(404, "없는 경로");
}
