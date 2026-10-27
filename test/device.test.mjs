import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseDevice, parseToken } from "../lib/device.mjs";
import { screenText } from "../lib/vt.mjs";

const text = (name) => screenText(readFileSync(new URL(`./fixtures/device/${name}.raw`, import.meta.url), "utf8"));

test("gh's device login gives the GitHub page and the one-time code", () => {
  assert.deepEqual(parseDevice("gh", text("gh")), { url: "https://github.com/login/device", code: "ABCD-1234" });
});

test("Codex's device login gives its page and code", () => {
  assert.deepEqual(parseDevice("codex", text("codex")), { url: "https://auth.openai.com/codex/device", code: "WXYZ-12345" });
});

test("claude setup-token gives the sign-in address, wrapped lines joined, and asks for a code", () => {
  const r = parseDevice("claude", text("claude"));
  assert.equal(r.code, null);
  assert.match(r.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=[\w-]+&response_type=code&/);
  assert.doesNotMatch(r.url, /\s/);
  assert.match(r.url, /state=fakestate$/);
});

test("nothing is parsed before the login shows its page", () => {
  assert.equal(parseDevice("gh", "Welcome"), null);
});

test("the long-lived Claude token is found once printed", () => {
  assert.equal(parseToken("Your token:\n\nsk-ant-oat01-Abc_def-123\n\nStore it safely"), "sk-ant-oat01-Abc_def-123");
  assert.equal(parseToken("Paste code here"), null);
});

test("the login terminal log is the owner's alone (0600), even under umask 002", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, statSync, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const log = join(mkdtempSync(join(tmpdir(), "ft-pty-")), "x.log");
  const old = process.umask(0o002);
  execFileSync("python3", ["-I", new URL("../bin/login-pty.py", import.meta.url).pathname, log, "echo", "token-line"], { stdio: ["pipe", "ignore", "ignore"], input: "" });
  process.umask(old);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.match(read(log, "utf8"), /token-line/);
});

test("a pasted code is typed first and Enter goes separately, so the prompt submits it", async () => {
  const { typeCode } = await import("../lib/device.mjs");
  const writes = [];
  await typeCode({ write: (s) => writes.push(s) }, "  abc#def \n", 10);
  assert.deepEqual(writes, ["abc#def", "\r"]);
});
