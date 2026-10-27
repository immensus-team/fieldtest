// The target repo's recipe (design §7): how to install, run, log in to, explore and check it.
// The bootstrap session writes it; the runner verifies it; only the human account promotes it.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "./config.mjs";

const KINDS = ["web", "electron", "tauri"];
const LOGINS = ["none", "form", "init-page"];
const STAGES = ["fast", "full"];

// Keys whose change can weaken the gate, so a repair that touches them waits for the human (§7.2).
export const GATE_KEYS = ["checks", "e2e", "unit", "paths", "autoRoute"];

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTextList = (v) => Array.isArray(v) && v.every(isText);

export function validateRecipe(r) {
  const errors = [];
  const need = (ok, key) => ok || errors.push(key);
  need(r?.version === 1, "version은 1이어야 합니다");
  need(/^[\w.-]+\/[\w.-]+$/.test(r?.repo ?? ""), "repo는 owner/name 형식이어야 합니다");
  need(isText(r?.baseBranch), "baseBranch가 없습니다");
  need(isText(r?.product?.name) && isText(r?.product?.summary) && isText(r?.product?.role), "product.name·summary·role이 필요합니다");
  need(KINDS.includes(r?.app?.kind), `app.kind는 ${KINDS.join("·")} 중 하나여야 합니다`);
  need(isText(r?.app?.root), "app.root가 없습니다");
  need(isTextList(r?.install), "install은 명령 목록이어야 합니다");
  need(r?.services == null || isText(r.services.compose), "services.compose가 없습니다");
  need(r?.env == null || (isText(r.env.fake) && isTextList(r.env.real ?? [])), "env.fake·real 형식이 틀렸습니다");
  need(r?.seed == null || isTextList(r.seed), "seed는 명령 목록이어야 합니다");
  need(isText(r?.start?.command) && isText(r?.start?.ready) && Number.isInteger(r?.start?.timeoutSec), "start.command·ready·timeoutSec이 필요합니다");
  need(LOGINS.includes(r?.login?.kind), `login.kind는 ${LOGINS.join("·")} 중 하나여야 합니다`);
  // A form login is an init page the bootstrap wrote that signs in with the seeded account.
  if (r?.login?.kind === "form") {
    const a = r.login.account;
    need(isText(a?.url) && isText(a?.user) && isText(a?.password), "login.account.url·user·password가 필요합니다");
  }
  if (["form", "init-page"].includes(r?.login?.kind)) need(isText(r.login.initPage), "login.initPage가 없습니다");
  need(isTextList(r?.explore?.journeys) && r.explore.journeys.length > 0, "explore.journeys가 하나 이상 필요합니다");
  need(isText(r?.explore?.screens), "explore.screens가 없습니다");
  for (const key of ["notes", "guideDocs", "productDocs"]) need(r?.explore?.[key] == null || typeof r.explore[key] === "string", `explore.${key}는 글이어야 합니다`);
  need(
    Array.isArray(r?.checks) && r.checks.length > 0 && r.checks.every((c) => isText(c?.name) && isText(c?.command) && STAGES.includes(c?.stage)),
    "checks는 {name, command, stage: fast|full} 목록이어야 합니다",
  );
  need(isText(r?.e2e?.cwd) && isText(r?.e2e?.dir) && isText(r?.e2e?.playwright) && isText(r?.e2e?.project), "e2e.cwd·dir·playwright·project가 필요합니다");
  need(r?.e2e?.notes == null || typeof r.e2e.notes === "string", "e2e.notes는 글이어야 합니다");
  need(r?.unit == null || (isText(r.unit.pattern) && isText(r.unit.cwd) && isText(r.unit.run)), "unit.pattern·cwd·run이 필요합니다");
  need(isTextList(r?.paths?.allowed) && isTextList(r?.paths?.forbidden), "paths.allowed·forbidden이 필요합니다");
  need(isText(r?.uiLanguage), "uiLanguage가 없습니다");
  need(r?.ci == null || isText(r.ci.workflow), "ci.workflow가 없습니다");
  need(r?.autoRoute === null || (Number.isInteger(r?.autoRoute?.files) && Number.isInteger(r?.autoRoute?.lines) && typeof r?.autoRoute?.copyCheck === "boolean"), "autoRoute는 null 또는 {files, lines, copyCheck}여야 합니다");
  return errors;
}

export function loadRecipe(dir = paths.recipe) {
  const abs = resolve(dir);
  let r;
  try {
    r = JSON.parse(readFileSync(join(abs, "recipe.json"), "utf8"));
  } catch (e) {
    throw new Error(`실행 지침을 읽지 못했습니다 (${abs}): ${e.message}`);
  }
  const errors = validateRecipe(r);
  if (errors.length) throw new Error(`실행 지침 오류 (${abs}):\n- ${errors.join("\n- ")}`);
  return { ...r, dir: abs };
}

export function recipeChanges(prev, next) {
  const keys = [...new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})])].filter((k) => k !== "dir");
  const changed = keys.filter((k) => JSON.stringify(prev?.[k]) !== JSON.stringify(next?.[k]));
  return { gate: changed.filter((k) => GATE_KEYS.includes(k)), other: changed.filter((k) => !GATE_KEYS.includes(k)) };
}

export function fill(command, vars) {
  return command.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
}

export const recipeScreensDir = (r) => join(r.dir, r.explore.screens);

// The bootstrap verifies a draft with the same code that runs the approved recipe: inside withRecipe(),
// this async flow and the processes it starts (FIELDTEST_RECIPE) read the draft. The other lane keeps
// reading the approved one.
const draft = new AsyncLocalStorage();
export const withRecipe = (dir, fn) => draft.run(resolve(dir), fn);
export const recipeEnv = () => (draft.getStore() ? { FIELDTEST_RECIPE: draft.getStore() } : {});

// The approved recipe, read again whenever recipe.json changes: the loop runs for days and the human
// can approve a repaired recipe meanwhile.
const cache = new Map();
export const currentRecipeDir = () => draft.getStore() ?? process.env.FIELDTEST_RECIPE ?? paths.recipe;
export function currentRecipe(dir = currentRecipeDir()) {
  const mtime = statSync(join(dir, "recipe.json")).mtimeMs;
  const hit = cache.get(dir);
  if (hit && hit.mtime === mtime) return hit.recipe;
  const recipe = loadRecipe(dir);
  cache.set(dir, { mtime, recipe });
  return recipe;
}

// The recipe in effect, or null before there is one (an empty draft, a fresh install).
export function maybeRecipe(dir = currentRecipeDir()) {
  try {
    return currentRecipe(dir);
  } catch {
    return null;
  }
}

export const repoSlug = () => currentRecipe().repo;
export const baseBranch = () => currentRecipe().baseBranch;
export const originBase = () => `origin/${baseBranch()}`;
