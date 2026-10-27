import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-publish-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { ownCommits, redeployAsHuman } = await import("../lib/publish.mjs");

test("published agent commits are re-authored as the human, trees and messages kept", async () => {
  const repo = mkdtempSync(join(tmpdir(), "uq-own-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Alex Doe");
  git("config", "user.email", "human@example.com");
  writeFileSync(join(repo, "a.txt"), "1");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  for (const n of [2, 3]) {
    writeFileSync(join(repo, "a.txt"), String(n));
    git("-c", "user.name=fieldtest agent", "-c", "user.email=agent@fieldtest.invalid", "commit", "--quiet", "-am", `fix ${n}`);
  }
  const tree = git("rev-parse", "HEAD^{tree}");

  await ownCommits(repo, base);

  assert.equal(git("log", "--format=%ae %ce", `${base}..HEAD`), "human@example.com human@example.com\nhuman@example.com human@example.com");
  assert.equal(git("log", "--format=%s", `${base}..HEAD`), "fix 3\nfix 2");
  assert.equal(git("rev-parse", "HEAD^{tree}"), tree);
  assert.equal(git("log", "-1", "--format=%ae", base), "human@example.com");
});

test("a fix that merged main keeps the merge and leaves main's commits alone", async () => {
  const repo = mkdtempSync(join(tmpdir(), "uq-own-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const agent = ["-c", "user.name=fieldtest agent", "-c", "user.email=agent@fieldtest.invalid"];
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Alex Doe");
  git("config", "user.email", "human@example.com");
  writeFileSync(join(repo, "a.txt"), "1");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  git("switch", "--quiet", "-c", "pr");
  writeFileSync(join(repo, "a.txt"), "pr");
  git(...agent, "commit", "--quiet", "-am", "pr change");
  const head = git("rev-parse", "HEAD");
  git("switch", "--quiet", "main");
  writeFileSync(join(repo, "a.txt"), "main");
  git("commit", "--quiet", "-am", "main change");
  const main = git("rev-parse", "HEAD");
  git("switch", "--quiet", "pr");
  // The two sides conflict, so the merge stops and the agent resolves it.
  assert.throws(() => execFileSync("git", ["merge", "--quiet", "main"], { cwd: repo, stdio: "ignore" }));
  writeFileSync(join(repo, "a.txt"), "both");
  git("add", ".");
  git(...agent, "commit", "--quiet", "--no-edit");
  const tree = git("rev-parse", "HEAD^{tree}");

  await ownCommits(repo, head);

  assert.equal(git("log", "-1", "--format=%ae %P", "HEAD"), `human@example.com ${head} ${main}`);
  assert.equal(git("rev-parse", "HEAD^{tree}"), tree);
});

test("a Vercel-blocked agent head gets one empty commit by the human", async () => {
  const origin = mkdtempSync(join(tmpdir(), "uq-origin-"));
  const repo = mkdtempSync(join(tmpdir(), "uq-clone-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(origin, "init", "--quiet", "--bare", "-b", "main");
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "config", "user.name", "Alex Doe");
  git(repo, "config", "user.email", "human@example.com");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "base");
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "-c", "user.name=fieldtest agent", "-c", "user.email=agent@fieldtest.invalid", "commit", "--quiet", "--allow-empty", "-m", "fix");
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/fix/x");
  writeFileSync(join(process.env.FIELDTEST_DATA, "config.json"), JSON.stringify({ myClone: repo }));

  assert.equal(await redeployAsHuman("fix/x"), true);
  assert.equal(git(origin, "log", "-1", "--format=%ae %s", "fix/x"), "human@example.com chore: redeploy the preview as a team member");
  assert.equal(await redeployAsHuman("fix/x"), false);
  assert.equal(git(origin, "rev-list", "--count", "fix/x"), "3");
});

