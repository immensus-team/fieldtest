// The target app as the recipe runs it, one per lane (lib/lane.mjs): PR work on 3200, exploration on
// 3210. Services (docker compose) and seed data come up first; sessions look at screens through the
// Playwright MCP browser, whose init page applies the recipe's login. Playwright tests start their own
// server on the lane's E2E_PORT.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { paths } from "./config.mjs";
import { gitOut, killGroup, run } from "./exec.mjs";
import { demoPort } from "./lane.mjs";
import { currentRecipe, fill, maybeRecipe } from "./recipe.mjs";

export const demoUrl = () => `http://127.0.0.1:${demoPort()}`;
// Host port a lane's services may publish (DB and the like), so two lanes never collide.
export const servicePort = () => demoPort() + 100;
// An Electron app opens its DevTools endpoint here; sessions drive its windows over CDP (design §9.2).
const cdpPort = () => demoPort() + 200;
export const demoCdp = (recipe = maybeRecipe()) => (recipe?.app.kind === "electron" ? `http://127.0.0.1:${cdpPort()}` : null);
const vars = (recipe = currentRecipe()) => ({ port: recipe.app.kind === "electron" ? cdpPort() : demoPort(), servicePort: servicePort(), baseUrl: demoUrl() });

// A web or Tauri frontend is ready when its address answers; an Electron app when its CDP endpoint does.
export const readyUrl = (recipe = currentRecipe()) => (demoCdp(recipe) ? `${demoCdp(recipe)}/json/version` : `${demoUrl()}${recipe.start.ready}`);

// Electron needs a display; a Linux server has none, so it runs under Xvfb.
export function appCommand(recipe = currentRecipe(), { platform = process.platform, display = process.env.DISPLAY } = {}) {
  const command = fill(recipe.start.command, vars(recipe));
  return recipe.app.kind === "electron" && platform === "linux" && !display ? `xvfb-run -a ${command}` : command;
}

const pidFile = () => join(paths.run, `demo-${demoPort()}.pid`);
const composeProject = () => `fieldtest-${demoPort()}`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function demoPid() {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8"));
    return pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

// KEY=value lines; values may use {port}, {servicePort} and {baseUrl}.
export function parseEnv(text, values = {}) {
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = fill(m[2].trim().replace(/^(['"])(.*)\1$/, "$2"), values);
  }
  return env;
}

const readEnv = (file) => (file && existsSync(file) ? parseEnv(readFileSync(file, "utf8"), vars()) : {});

// The app's environment: fake values from the recipe, then the real keys the installer gave.
export function appEnv(recipe = currentRecipe()) {
  return {
    ...process.env,
    ...readEnv(recipe.env?.fake && join(recipe.dir, recipe.env.fake)),
    ...readEnv(paths.recipeSecrets),
    FIELDTEST_PORT: String(demoPort()),
    FIELDTEST_SERVICE_PORT: String(servicePort()),
  };
}

function compose(recipe, args, opts) {
  return run("docker", ["compose", "-p", composeProject(), "-f", join(recipe.dir, recipe.services.compose), ...args], opts);
}

export function stopDemo() {
  const pid = demoPid();
  if (pid) {
    killGroup(pid, "SIGTERM");
    setTimeout(() => killGroup(pid, "SIGKILL"), 5000).unref();
  }
  rmSync(pidFile(), { force: true });
  const recipe = maybeRecipe();
  if (recipe?.services) compose(recipe, ["down", "-v", "--remove-orphans"], { env: appEnv(recipe) });
  return pid;
}

async function waitUp(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// { ok, already?, log, stage? }: stage names the step that failed (services, seed, start).
export async function startDemo(cwd) {
  if (demoPid()) return { ok: true, already: true };
  const recipe = currentRecipe();
  const wt = await gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  mkdirSync(paths.run, { recursive: true });
  const log = join(paths.run, `demo-${demoPort()}.log`);
  writeFileSync(log, "");
  const env = appEnv(recipe);
  const limit = recipe.start.timeoutSec * 1000;
  if (recipe.services) {
    const up = await compose(recipe, ["up", "-d", "--wait"], { cwd: wt, env, logFile: log, timeoutMs: limit });
    if (up.code !== 0) return { ok: false, log, stage: "services" };
  }
  for (const command of recipe.seed ?? []) {
    const r = await run("/bin/sh", ["-c", fill(command, vars())], { cwd: wt, env, logFile: log, timeoutMs: limit });
    if (r.code !== 0) return { ok: false, log, stage: "seed" };
  }
  const fd = openSync(log, "a");
  const child = spawn("/bin/sh", ["-c", appCommand(recipe)], { cwd: join(wt, recipe.app.root), env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  writeFileSync(pidFile(), String(child.pid));
  child.unref();
  if (await waitUp(readyUrl(recipe), limit)) return { ok: true, log };
  stopDemo();
  return { ok: false, log, stage: "start" };
}

// recipe.login.initPage is "<file>#<export>": the file is relative to the app root, or to the recipe
// directory with a "recipe:" prefix; without #, its default export. The export gets (page, { baseUrl,
// account }) on every page the Playwright MCP browser opens.
export function initPageRef(ref, wt, recipe) {
  const [file, name = "default"] = ref.split("#");
  const path = file.startsWith("recipe:") ? join(recipe.dir, file.slice("recipe:".length)) : join(wt, recipe.app.root, file);
  return { path, name };
}

// TypeScript init pages are bundled with the app's own esbuild (directly or through tsx).
const BUNDLE = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [root, entry, outfile] = process.argv.slice(1);
const req = createRequire(root + "/package.json");
let at;
try { at = req.resolve("esbuild"); } catch { at = createRequire(req.resolve("tsx/package.json")).resolve("esbuild"); }
const esbuild = await import(pathToFileURL(at).href);
await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", external: ["@playwright/test"], outfile, logLevel: "error" });
`;

// The init page for the MCP browser, or null when the recipe needs no login.
export async function loginInit(wt, dir, recipe = currentRecipe()) {
  if (recipe.login.kind === "none") return null;
  const { path, name } = initPageRef(recipe.login.initPage, wt, recipe);
  let module = path;
  if (/\.tsx?$/.test(path)) {
    module = join(dir, "login-bundle.mjs");
    const root = join(wt, recipe.app.root);
    const r = await run(process.execPath, ["--input-type=module", "-e", BUNDLE, root, path, module], { cwd: root });
    if (r.code !== 0) throw new Error(`로그인 init page 묶기 실패\n${(r.stderr || r.stdout).slice(-1500)}`);
  }
  const init = join(dir, "login-init.mjs");
  const call = name === "default" ? "mod.default" : `mod[${JSON.stringify(name)}]`;
  const context = JSON.stringify({ baseUrl: demoUrl(), account: recipe.login.account ?? null });
  writeFileSync(init, `import * as mod from ${JSON.stringify(pathToFileURL(module).href)};\nexport default async ({ page }) => {\n  await ${call}(page, ${context});\n};\n`);
  return init;
}
