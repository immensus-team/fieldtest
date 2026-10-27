import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-merge-data-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { commitFixRound } = await import("../lib/agent.mjs");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "uq-merge-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.name", "t");
  g("config", "user.email", "t@example.invalid");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  g("checkout", "-qb", "pr");
  writeFileSync(join(dir, "a.txt"), "pr\n");
  g("commit", "-qam", "pr change");
  g("checkout", "-q", "main");
  return { dir, g };
}

const parents = (g) => g("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length - 1;

test("merge --no-commit then the runner commit makes a merge commit", async () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "b.txt"), "main\n");
  g("commit", "-qam", "main change");
  g("checkout", "-q", "pr");
  g("merge", "--no-commit", "--no-ff", "main");
  await commitFixRound(dir, "fix(web): address review round 1");
  assert.equal(parents(g), 2);
  assert.equal(g("show", "HEAD:b.txt"), "main");
});

test("a resolved conflict is committed as a merge commit", async () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "a.txt"), "main\n");
  g("commit", "-qam", "main change");
  g("checkout", "-q", "pr");
  try {
    g("merge", "--no-commit", "main");
  } catch {}
  writeFileSync(join(dir, "a.txt"), "resolved\n");
  await commitFixRound(dir, "fix(web): address review round 1");
  assert.equal(parents(g), 2);
  assert.equal(g("show", "HEAD:a.txt"), "resolved");
  assert.equal(g("status", "--porcelain"), "");
});

test("a plain fix stays a normal commit, no change makes no commit", async () => {
  const { dir, g } = repo();
  g("checkout", "-q", "pr");
  const before = g("rev-parse", "HEAD");
  assert.equal(await commitFixRound(dir, "noop"), before);
  writeFileSync(join(dir, "a.txt"), "fixed\n");
  await commitFixRound(dir, "fix");
  assert.equal(parents(g), 1);
});
