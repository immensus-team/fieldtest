import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBash, checkTool } from "../lib/guard.mjs";

test("denies git commands the runner owns, wherever they hide", () => {
  for (const cmd of [
    "git commit -am x",
    "git push origin HEAD",
    "git checkout -b x",
    "git switch main",
    "git branch -D x",
    "git reset --hard",
    "git rebase main",
    "git cherry-pick abc",
    "git tag v1",
    "git stash",
    "git worktree add ../x",
    "git clean -fdx",
    "git -C apps/web commit -m x",
    "git -c user.name=a commit -m x",
    'bash -c "git push"',
    "pnpm lint && git commit -m done",
    "echo ok; git push",
    "true || git reset --hard",
    "git config alias.c commit",
    "git merge origin/main",
    "git merge main --no-ff",
  ]) {
    assert.ok(checkBash(cmd), cmd);
  }
});

test("allows read-only git and merge --no-commit", () => {
  for (const cmd of [
    "git status --short",
    "git diff origin/main...HEAD | head -50",
    "git log --oneline -5",
    "git show HEAD:apps/web/package.json",
    "git blame apps/web/src/a.tsx",
    "git ls-files apps/web/e2e",
    "git grep -n composer",
    "git merge-base origin/main HEAD",
    "echo $(git rev-parse HEAD)",
    "git restore apps/web/src/a.tsx",
    "git merge --no-commit origin/main",
    "pnpm exec playwright test e2e/composer.spec.ts",
  ]) {
    assert.equal(checkBash(cmd), null, cmd);
  }
});

test("denies gh in any form", () => {
  for (const cmd of ["gh pr list", "/opt/homebrew/bin/gh api user", "cd x && gh issue view 1"]) assert.ok(checkBash(cmd), cmd);
  assert.equal(checkBash("echo sigh high"), null);
});

test(".env files are off limits except .env.example", () => {
  assert.ok(checkBash("cat apps/web/.env.local"));
  assert.ok(checkBash("cat .env"));
  assert.ok(checkBash("grep KEY apps/web/.env.production"));
  assert.equal(checkBash("cat apps/web/.env.example"), null);
  assert.ok(checkTool("Read", { file_path: "/x/apps/web/.env.local" }));
  assert.equal(checkTool("Read", { file_path: "/x/apps/web/.env.example" }), null);
  assert.ok(checkTool("Grep", { pattern: "KEY", glob: ".env*" }));
  assert.equal(checkTool("Grep", { pattern: "KEY", glob: "*.ts" }), null);
  assert.equal(checkTool("Edit", { file_path: "/x/a.tsx" }), null);
});
