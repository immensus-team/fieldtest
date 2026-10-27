import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("start.sh reads the approved run guide from the approved directory, not the agent's data", () => {
  const root = mkdtempSync(join(tmpdir(), "ft-start-"));
  const data = join(root, "data");
  const approved = join(root, "approved");
  mkdirSync(data);
  mkdirSync(join(approved, "recipe"), { recursive: true });
  // getent is Linux-only; the script only needs it to answer.
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "getent"), "#!/bin/sh\necho agent:x:1:1::/home/agent:/bin/bash\n");
  chmodSync(join(bin, "getent"), 0o755);
  const install = join(root, "install.json");
  writeFileSync(install, JSON.stringify({ data, approved }));
  const r = spawnSync("bash", [new URL("../setup/start.sh", import.meta.url).pathname], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIELDTEST_INSTALL: install }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${approved}/recipe/recipe.json`));
});
