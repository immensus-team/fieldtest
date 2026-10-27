import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-setup-"));
process.env.FIELDTEST_APPROVED = join(process.env.FIELDTEST_DATA, "approved");
const { STEPS, completeStep, currentStep, invalidate, readSetup, setupDone } = await import("../lib/setup.mjs");

test("the wizard starts at the server check and walks the steps in order", () => {
  assert.deepEqual(STEPS, ["server", "github", "repo", "claude", "codex", "slack", "bootstrap", "recipe", "start"]);
  assert.equal(currentStep(readSetup()), "server");
  completeStep("server", { disk: "80 GB" });
  completeStep("github", { login: "octocat" });
  assert.equal(currentStep(readSetup()), "repo");
  assert.equal(readSetup().steps.github.info.login, "octocat");
  assert.equal(setupDone(), false);
});

test("choosing another repo voids the bootstrap and the recipe, not the logins", () => {
  for (const s of ["repo", "claude", "codex", "slack", "bootstrap", "recipe"]) completeStep(s, {});
  invalidate("repo");
  const st = readSetup().steps;
  assert.equal(st.repo.done, false);
  assert.equal(st.bootstrap.done, false);
  assert.equal(st.recipe.done, false);
  assert.equal(st.claude.done, true);
  assert.equal(currentStep(readSetup()), "repo");
});

test("another GitHub account voids the repo too", () => {
  completeStep("repo", {});
  invalidate("github");
  const st = readSetup().steps;
  assert.equal(st.github.done, false);
  assert.equal(st.repo.done, false);
  assert.equal(st.codex.done, true);
});

test("setup is done after the start step", () => {
  for (const s of STEPS) completeStep(s, {});
  assert.equal(setupDone(), true);
  assert.equal(currentStep(readSetup()), null);
});

test("the wizard's state is not writable by the agent's group, even under umask 002", async () => {
  const { statSync } = await import("node:fs");
  const { paths } = await import("../lib/config.mjs");
  const old = process.umask(0o002);
  completeStep("server", {});
  process.umask(old);
  assert.equal(statSync(paths.setup).mode & 0o777, 0o644);
});
