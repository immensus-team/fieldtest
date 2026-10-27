// GitHub-side steps shared by `fieldtest approve` and `fieldtest watch`. Runs as the human user.
// Commits come from the agent only as bundle files; we never run git inside the agent's repository,
// so its hooks and config can't execute with our credentials.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIRROR, settings } from "./config.mjs";
import { git, gitOut, must, run } from "./exec.mjs";
import { install, repoCheck, reviewLines } from "./gate.mjs";
import { replaceBlock } from "./github.mjs";
import { baseBranch, currentRecipe, originBase, repoSlug } from "./recipe.mjs";
import { shotRows } from "./shots.mjs";

export function clone() {
  return settings().myClone;
}

// Brings the agent's source up to date with GitHub (runs as the human).
export async function syncMirror() {
  await run("git", ["--git-dir", MIRROR, "remote", "update", "--prune"]);
}

// Also fetches the given PR branches: a fix bundle is built on the PR head, which may be a commit only
// GitHub has (an update from the base branch made there).
export async function fetchMain(...branches) {
  const refs = [baseBranch(), ...branches].map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
  await git(clone(), ["fetch", "--quiet", "origin", ...refs]);
}

// Imports `branch` from a bundle into refs/fieldtest/<name> and returns its commit.
export async function importBundle(bundleFile, branch, name) {
  await git(clone(), ["bundle", "verify", "--quiet", bundleFile]);
  await git(clone(), ["fetch", "--quiet", "--force", bundleFile, `refs/heads/${branch}:refs/fieldtest/${name}`]);
  return gitOut(clone(), ["rev-parse", `refs/fieldtest/${name}`]);
}

// The agent commits as "fieldtest agent <agent@fieldtest.invalid>". Vercel blocks a deployment
// whose head commit author is not on the team, with no build log, so the commits we publish are
// re-authored as the human (the clone's git identity), as the user chose on 2026-10-19. Same trees,
// messages and parents: a fix that merged main stays a merge (a rebase would replay main's commits
// onto the PR and stop on their conflicts). Only the PR's own line (first parents) is rewritten.
export async function ownCommits(wt, base) {
  const shas = (await must("git", ["rev-list", "--reverse", "--first-parent", `${base}..HEAD`], { cwd: wt })).stdout.split("\n").filter(Boolean);
  let prev = null;
  for (const sha of shas) {
    const [tree, ...parents] = (await must("git", ["log", "-1", "--format=%T %P", sha], { cwd: wt })).stdout.trim().split(" ");
    const message = (await must("git", ["log", "-1", "--format=%B", sha], { cwd: wt })).stdout;
    if (prev) parents[0] = prev;
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"];
    prev = (await must("git", args, { cwd: wt, input: message })).stdout.trim();
  }
  if (prev) await must("git", ["reset", "--quiet", "--soft", prev], { cwd: wt });
}

// A PR head the agent pushed before ownCommits existed stays blocked on Vercel. An empty commit by
// the human redeploys it. Returns false when the head is already the human's (blocked for another
// reason), so this never pushes twice for the same block.
export function redeployAsHuman(branch) {
  return pushEmpty(branch, "chore: redeploy the preview as a team member", { unlessMine: true });
}

// A PR whose CI passed on an older main is merged without running CI again: it is merged into the
// current main here and the checks that catch a broken combination (a removed export, a renamed
// type) run on the result: the recipe's fast checks. The browser suite runs on the base branch after
// the merges (aftermerge.mjs).
export const mergeChecks = () => currentRecipe().checks.filter((c) => c.stage === "fast");

export async function checkOnMain(branch, logFile) {
  await fetchMain(branch);
  return withTempWorktree(originBase(), async (wt) => {
    const merged = await run("git", ["merge", "--quiet", "--no-commit", "--no-ff", `origin/${branch}`], { cwd: wt, logFile });
    if (merged.code !== 0) return { ok: false, conflict: true, failed: [] };
    const inst = await install(wt, logFile);
    if (inst.code !== 0) return { ok: false, conflict: false, failed: ["install"] };
    const failed = [];
    for (const check of mergeChecks()) if ((await repoCheck(wt, check, logFile)).code !== 0) failed.push(check.name);
    return { ok: failed.length === 0, conflict: false, failed };
  });
}

async function pushEmpty(branch, message, { unlessMine = false } = {}) {
  await fetchMain(branch);
  return withTempWorktree(`origin/${branch}`, async (wt) => {
    const author = (await must("git", ["log", "-1", "--format=%ae"], { cwd: wt })).stdout.trim();
    const me = (await must("git", ["config", "user.email"], { cwd: wt })).stdout.trim();
    if (unlessMine && author === me) return false;
    await must("git", ["commit", "--quiet", "--allow-empty", "--no-verify", "-m", message], { cwd: wt });
    await must("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
    return true;
  });
}

export async function withTempWorktree(ref, fn) {
  const dir = mkdtempSync(join(tmpdir(), "uq-"));
  await git(clone(), ["worktree", "add", "--quiet", "--detach", dir, ref]);
  try {
    return await fn(dir);
  } finally {
    await run("git", ["worktree", "remove", "--force", dir], { cwd: clone() });
    rmSync(dir, { recursive: true, force: true });
    await run("git", ["worktree", "prune"], { cwd: clone() });
  }
}

// Commits screenshots under docs/pr-assets, then a commit that stops tracking them, following
// the repository rule. Returns the asset commit (for image links) or null when there are no shots.
export async function addAssetCommits(wt, ticketId, shotsDir, shots) {
  if (!shots.length) return null;
  const rel = `docs/pr-assets/${ticketId.toLowerCase()}`;
  mkdirSync(join(wt, rel), { recursive: true });
  for (const f of shots) cpSync(join(shotsDir, f), join(wt, rel, f));
  await git(wt, ["add", "-f", rel]);
  await git(wt, ["commit", "--quiet", "--no-verify", "-m", `chore: add ${ticketId} review screenshots`]);
  const assetSha = await gitOut(wt, ["rev-parse", "HEAD"]);
  await git(wt, ["rm", "-r", "--cached", "--quiet", "docs/pr-assets"]);
  await git(wt, ["commit", "--quiet", "--no-verify", "-m", `chore: stop tracking ${ticketId} review screenshots`]);
  return { assetSha, rel };
}

// Image links for the files of one asset commit: [{ name, url }].
export function assetShots(asset, shots) {
  if (!asset) return [];
  return shots.map((f) => ({ name: f, url: `https://github.com/${repoSlug()}/blob/${asset.assetSha}/${asset.rel}/${f}?raw=true` }));
}

// Image links already in a PR body's screenshot block, for PRs made before tickets kept them.
export function shotsInBody(body) {
  const block = body?.match(/<!-- quality:screenshots -->([\s\S]*?)<!-- \/quality:screenshots -->/)?.[1] ?? "";
  const seen = new Map();
  for (const m of block.matchAll(/https:\/\/github\.com\/[^\s)"']+\/((?:before|after)-[^/\s)"'?]+\.png)\?raw=true/g)) seen.set(m[1], { name: m[1], url: m[0] });
  return [...seen.values()];
}

// Later rounds replace the "after" images they retook and keep everything else, so "before" stays.
export function mergeShots(old, fresh) {
  return [...old.filter((o) => !fresh.some((f) => f.name === o.name)), ...fresh];
}

// One row per screen width and theme: 화면 | 수정 전 | 수정 후, narrow screens first, light before dark.
export function screenshotTable(entries) {
  if (!entries.length) return "스크린샷 없음";
  const url = new Map(entries.map((e) => [e.name, e.url]));
  const cell = (name) => (name ? `<img src="${url.get(name)}" width="360" alt="${name.replace(/\.png$/, "")}">` : "없음");
  const rows = shotRows(entries.map((e) => e.name));
  return ["| 화면 | 수정 전 | 수정 후 |", "| --- | --- | --- |", ...rows.map((r) => `| ${r.label} | ${cell(r.before)} | ${cell(r.after)} |`)].join("\n");
}

export function withScreenshots(body, markdown) {
  const block = `<!-- quality:screenshots -->\n${markdown}\n<!-- /quality:screenshots -->`;
  if (body.includes("{{SCREENSHOTS}}")) return body.replace("{{SCREENSHOTS}}", block);
  return replaceBlock(body, "screenshots", markdown);
}

// The runner's own gate result, so the PR shows checks the session itself didn't run.
export function withGateResult(body, gate) {
  if (!gate?.steps?.length) return body;
  const lines = gate.steps.map((s) => `- ${s.ok ? "통과" : "실패"}: ${s.name}`).join("\n");
  let out = replaceBlock(body, "gate", `### 실행기 검증 (게이트)\n\n${lines}`);
  const passed = (name) => gate.steps.some((s) => s.ok && s.name === name);
  // A PR template with a "- [ ] <check name>" line gets it ticked when that check passed.
  for (const { name } of currentRecipe().checks) if (passed(name)) out = out.replace(`- [ ] ${name}`, `- [x] ${name}`);
  if (gate.steps.some((s) => s.ok && /e2e|재현 테스트 통과/.test(s.name))) out = out.replace("- [ ] Local test", "- [x] Local test");
  return out;
}

export function withReviewResult(body, review) {
  return review ? replaceBlock(body, "review", `### 로컬 검토 (Codex)\n\n${reviewLines(review)}`) : body;
}

export function writeTemp(name, text) {
  const dir = mkdtempSync(join(tmpdir(), "uq-body-"));
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}
