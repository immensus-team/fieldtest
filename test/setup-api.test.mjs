import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-setup-api-"));
process.env.FIELDTEST_APPROVED = join(process.env.FIELDTEST_DATA, "approved");
const { stopChild } = await import("../lib/setup-api.mjs");

test("a running bootstrap is stopped and waited for before its state is reset", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((ok) => child.once("spawn", ok));
  try {
    await stopChild(child);
    assert.equal(child.signalCode, "SIGTERM");
    await stopChild(child);
    await stopChild(null);
  } finally {
    child.kill("SIGKILL");
  }
});
