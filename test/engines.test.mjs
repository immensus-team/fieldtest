import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-engines-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { mcpArgs } = await import("../lib/engines.mjs");

test("a web app gets its own headless Chromium with the login init page", () => {
  const args = mcpArgs("/s", "/i.mjs", null);
  assert.deepEqual(args.slice(1, 3), ["--browser", "chromium"]);
  assert.ok(args.includes("--init-page"));
  assert.ok(!args.includes("--cdp-endpoint"));
});

test("an Electron app is driven over CDP: no browser of its own, no init page", () => {
  const args = mcpArgs("/s", "/i.mjs", "http://127.0.0.1:9333");
  assert.deepEqual(args.slice(1, 3), ["--cdp-endpoint", "http://127.0.0.1:9333"]);
  assert.ok(!args.includes("--browser"));
  assert.ok(!args.includes("--init-page"));
});
