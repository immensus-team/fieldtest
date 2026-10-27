import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.HOME = mkdtempSync(join(tmpdir(), "ft-slack-home-"));
process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "ft-slack-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const envFile = join(process.env.HOME, ".config", "fieldtest", "slack.env");
mkdirSync(join(process.env.HOME, ".config", "fieldtest"), { recursive: true });
writeFileSync(envFile, "SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\n");
const posts = [];
globalThis.fetch = async (url, { body }) => {
  posts.push({ method: url.split("/").pop(), params: Object.fromEntries(new URLSearchParams(body)) });
  return { status: 200, json: async () => ({ ok: true, ts: "1.0", channel: { id: "D1" } }) };
};
const { claimOwner, manifestUrl, slackManifest, slackNotice } = await import("../lib/slack.mjs");

test("the manifest names the install and asks only for DM scopes, the DM event and Socket Mode", () => {
  const m = slackManifest("shop");
  assert.equal(m.display_information.name, "fieldtest · shop");
  assert.equal(m.features.bot_user.display_name, "fieldtest · shop");
  assert.deepEqual(m.oauth_config.scopes.bot.sort(), ["chat:write", "im:history", "im:write"]);
  assert.deepEqual(m.settings.event_subscriptions.bot_events, ["message.im"]);
  assert.equal(m.settings.socket_mode_enabled, true);
  assert.equal(m.settings.interactivity.is_enabled, true);
});

test("the create link carries the manifest", () => {
  const url = new URL(manifestUrl(slackManifest("shop")));
  assert.equal(url.origin + url.pathname, "https://api.slack.com/apps");
  assert.equal(url.searchParams.get("new_app"), "1");
  assert.equal(JSON.parse(url.searchParams.get("manifest_json")).display_information.name, "fieldtest · shop");
});

test("the first person to DM the bot becomes the owner; later ones are ignored", async () => {
  assert.equal(await claimOwner({ type: "message", channel_type: "im", user: "U1", channel: "D1" }), true);
  assert.match(readFileSync(envFile, "utf8"), /^SLACK_USER_ID=U1$/m);
  assert.equal(posts.at(-1).method, "chat.postMessage");
  assert.match(posts.at(-1).params.text, /연결됨/);
  assert.equal(await claimOwner({ type: "message", channel_type: "im", user: "U2", channel: "D2" }), false);
  assert.doesNotMatch(readFileSync(envFile, "utf8"), /U2/);
});

test("notices start with the install name", async () => {
  await slackNotice("main 검사 실패");
  assert.match(posts.at(-1).params.text, /^\[fieldtest\] main 검사 실패$/);
});
