import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "uq-watch-"));
process.env.FIELDTEST_DATA = join(root, "data");
process.env.HOME = join(root, "home");
mkdirSync(join(process.env.HOME, ".config", "fieldtest"), { recursive: true });
writeFileSync(join(process.env.HOME, ".config", "fieldtest", "slack.env"), "SLACK_BOT_TOKEN=xoxb-test\nSLACK_USER_ID=U1\n");
mkdirSync(join(process.env.FIELDTEST_DATA, "run"), { recursive: true });
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();

const { mainHealth } = await import("../lib/watch.mjs");
const { paths } = await import("../lib/config.mjs");
const { writeState } = await import("../lib/store.mjs");

// Records Slack calls; `down` makes every call fail like a network outage.
function fakeSlack({ down = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, { body }) => {
    if (down) throw new Error("getaddrinfo ENOTFOUND slack.com");
    const method = url.split("/").pop();
    calls.push({ method, ...Object.fromEntries(body) });
    const result = method === "conversations.open" ? { channel: { id: "D1" } } : { ts: `${calls.length}.0` };
    return { status: 200, json: async () => ({ ok: true, ...result }) };
  };
  return calls;
}

const watchState = () => JSON.parse(readFileSync(join(paths.run, "watch-state.json"), "utf8"));

test("a loop failing 3 times posts to Slack with the loop.log tail in the thread, once", async () => {
  const at = "2026-10-16T16:05:54.496Z";
  writeFileSync(join(paths.run, "loop.log"), `[${at}] 오류 (3회 연속), 60분 뒤 재시도: claude 실패 (exit 1): <ENOTFOUND> \`\`\`x\`\`\`\n`);
  writeState({ screens: {}, failures: 3, lastError: { at, message: "claude 실패 (exit 1): API Error\n{...}" } });

  let calls = fakeSlack({ down: true });
  await mainHealth();
  assert.equal(watchState().failuresNotified, undefined, "a failed post is retried on the next run");
  const file = join(paths.run, "errors", "loop-2026-10-16T16-05-54-496Z.log");
  assert.ok(existsSync(file), "the log is saved even when Slack is unreachable");

  calls = fakeSlack();
  await mainHealth();
  const posts = calls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 2);
  assert.match(posts[0].text, /^\[fieldtest\] 에이전트 루프 오류 3회 연속: claude 실패 \(exit 1\): API Error\n로그: .*loop-2026-10-16T16-05-54-496Z\.log$/);
  assert.equal(posts[1].thread_ts, "2.0");
  assert.match(posts[1].text, /^```\n.*&lt;ENOTFOUND&gt; '''x'''\n```$/s);
  assert.equal(watchState().failuresNotified, at);

  calls = fakeSlack();
  await mainHealth();
  assert.equal(calls.length, 0);
});

test("a broken main posts the base check log", async () => {
  const sha = "abcdef1234567890";
  mkdirSync(paths.baseChecks, { recursive: true });
  writeFileSync(join(paths.baseChecks, `${sha}.log`), "typecheck: error TS2304\n");
  writeState({ screens: {}, failures: 0, mainBroken: { sha, ok: false, failed: ["typecheck"] } });
  const calls = fakeSlack();
  await mainHealth();
  const posts = calls.filter((c) => c.method === "chat.postMessage");
  assert.match(posts[0].text, /^\[fieldtest\] main abcdef1 검사 실패 \(typecheck\)/);
  assert.match(posts[1].text, /error TS2304/);
  assert.equal(watchState().mainBrokenNotified, sha);
});
