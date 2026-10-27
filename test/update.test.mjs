import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "ft-update-"));
process.env.FIELDTEST_DATA = join(root, "data");
process.env.FIELDTEST_APPROVED = join(root, "approved");
const { decide, draining, drainFile, newestTag, update, updateAlerts, updateFile } = await import("../lib/update.mjs");

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], { cwd, encoding: "utf8" }).trim();

// The public repo with two releases, and an install at the first.
const origin = join(root, "origin");
execFileSync("git", ["init", "-q", "-b", "main", origin]);
function release(tag) {
  writeFileSync(join(origin, "VERSION"), tag);
  git(origin, "add", "VERSION");
  git(origin, "commit", "-qm", tag);
  git(origin, "tag", tag);
}
release("v0.1.0");
release("v0.2.0");
const code = join(root, "code");
execFileSync("git", ["clone", "-q", origin, code]);
git(code, "checkout", "-q", "--detach", "v0.1.0");
const version = () => readFileSync(join(code, "VERSION"), "utf8");
const state = () => JSON.parse(readFileSync(updateFile(), "utf8"));
const ok = { codeDir: code, start: ["true"], healthy: async () => true, busy: () => null, log: () => {} };

test("the newest release tag wins; other tags are not releases", () => {
  assert.equal(newestTag(["v0.10.0-rc1", "v0.10.0", "v0.9.0", "nightly"]), "v0.10.0");
  assert.equal(newestTag(["nightly"]), null);
});

test("an install waits while the agent works, but not past the longest wait", () => {
  const at = Date.parse("2026-10-28T03:00:00Z");
  assert.equal(decide({ current: "v0.1.0", newest: "v0.1.0", busy: null, now: at }).action, "none");
  assert.equal(decide({ current: "v0.1.0", newest: "v0.2.0", busy: "pr: 구현", now: at }).action, "wait");
  assert.equal(decide({ current: "v0.1.0", newest: "v0.2.0", busy: "pr: 구현", waitingSince: "2026-10-28T02:00:00Z", now: at }).action, "wait");
  assert.equal(decide({ current: "v0.1.0", newest: "v0.2.0", busy: "pr: 구현", waitingSince: "2026-10-28T00:59:00Z", now: at }).action, "apply");
  assert.equal(decide({ current: "v0.1.0", newest: "v0.2.0", busy: null, failed: "v0.2.0", now: at }).action, "none");
  assert.equal(decide({ current: null, newest: "v0.2.0", busy: null, now: at }).action, "apply");
});

test("a busy install records since when it waits", async () => {
  const r = await update({ ...ok, busy: () => "pr: 구현" });
  assert.equal(r.action, "wait");
  assert.equal(version(), "v0.1.0");
  assert.equal(state().waiting.tag, "v0.2.0");
  // The loop takes no new work while a release waits, so the running task is the last before it.
  assert.equal(draining(), true);
});

test("an idle install moves to the newest release and restarts with it", async () => {
  const r = await update(ok);
  assert.equal(r.action, "applied");
  assert.equal(version(), "v0.2.0");
  assert.equal(state().current, "v0.2.0");
  assert.equal(state().waiting, null);
  assert.deepEqual(updateAlerts(state()), []);
  assert.equal(draining(), false);
});

test("a drain mark older than the longest wait no longer holds the loop", async () => {
  const { mkdirSync, utimesSync, writeFileSync: write } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(drainFile()), { recursive: true });
  write(drainFile(), "v9.9.9");
  assert.equal(draining(), true);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(drainFile(), old, old);
  assert.equal(draining(), false);
});

test("a release that does not come up is rolled back and not tried again", async () => {
  release("v0.3.0");
  const r = await update({ ...ok, healthy: async () => version() !== "v0.3.0" });
  assert.equal(r.action, "rolled-back");
  assert.equal(version(), "v0.2.0");
  assert.equal(state().failed, "v0.3.0");
  assert.match(updateAlerts(state())[0].text, /v0\.3\.0 업데이트에 실패해 이전 버전\(v0\.2\.0\)으로 되돌렸습니다/);
  assert.equal((await update(ok)).action, "none");
  assert.equal(version(), "v0.2.0");
});
