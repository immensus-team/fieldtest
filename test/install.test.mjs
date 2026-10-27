import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readInstall } from "../lib/install.mjs";

const dir = mkdtempSync(join(tmpdir(), "ft-install-"));

test("readInstall falls back to the new-install defaults without a file", () => {
  assert.deepEqual(readInstall(join(dir, "missing.json")), {
    name: "fieldtest",
    human: "fieldtest",
    agent: "fieldtest-agent",
    code: "/srv/fieldtest/code",
    data: "/srv/fieldtest/data",
    runtime: "/srv/fieldtest/runtime",
    mirror: "/srv/fieldtest/mirror.git",
    approved: "/srv/fieldtest/approved",
    clone: "/home/fieldtest/clone",
    webPort: 4310,
  });
});

test("readInstall keeps defaults for keys the file leaves out", () => {
  const file = join(dir, "partial.json");
  writeFileSync(file, JSON.stringify({ name: "shop", human: "alice", webPort: 4311 }));
  const install = readInstall(file);
  assert.equal(install.name, "shop");
  assert.equal(install.human, "alice");
  assert.equal(install.webPort, 4311);
  assert.equal(install.agent, "fieldtest-agent");
  assert.equal(install.data, "/srv/fieldtest/data");
});

test("readInstall rejects a broken file", () => {
  const file = join(dir, "broken.json");
  writeFileSync(file, "{ nope");
  assert.throws(() => readInstall(file), /install\.json을 읽지 못했습니다/);
});
