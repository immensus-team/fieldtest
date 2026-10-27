import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-demo-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { initPageRef, parseEnv } = await import("../lib/demo.mjs");
const { currentRecipe } = await import("../lib/recipe.mjs");

test("env files fill the lane's ports and drop quotes", () => {
  const env = parseEnv('# comment\nDATABASE_URL="postgres://x@127.0.0.1:{servicePort}/db"\nAPP_URL={baseUrl}\n', { servicePort: 3300, baseUrl: "http://127.0.0.1:3200" });
  assert.deepEqual(env, { DATABASE_URL: "postgres://x@127.0.0.1:3300/db", APP_URL: "http://127.0.0.1:3200" });
});

test("an init page lives in the app root, or in the recipe with recipe:", () => {
  const r = currentRecipe();
  assert.deepEqual(initPageRef("e2e/fixtures/routes.ts#mockShop", "/wt", r), { path: "/wt/web/e2e/fixtures/routes.ts", name: "mockShop" });
  assert.deepEqual(initPageRef("recipe:login.mjs", "/wt", r), { path: join(r.dir, "login.mjs"), name: "default" });
});

test("an Electron app starts on the lane's CDP port, under Xvfb on a Linux server without a display", async () => {
  const { appCommand, demoCdp, readyUrl } = await import("../lib/demo.mjs");
  const electron = { ...currentRecipe(), app: { kind: "electron", root: "." }, start: { command: "npx electron . --remote-debugging-port={port}", ready: "/", timeoutSec: 60 } };
  const port = Number(new URL(demoCdp(electron)).port);
  assert.equal(readyUrl(electron), `http://127.0.0.1:${port}/json/version`);
  assert.equal(appCommand(electron, { platform: "linux", display: undefined }), `xvfb-run -a npx electron . --remote-debugging-port=${port}`);
  assert.equal(appCommand(electron, { platform: "darwin", display: undefined }), `npx electron . --remote-debugging-port=${port}`);
  assert.equal(demoCdp(currentRecipe()), null);
});
