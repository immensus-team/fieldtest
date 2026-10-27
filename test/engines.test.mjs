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

const toolEvent = (name, input) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "x" }, { type: "tool_use", name, input }] } });

test("a session's tool calls read as what it is doing now", async () => {
  const { activityOf } = await import("../lib/engines.mjs");
  const at = (name, input) => activityOf(toolEvent(name, input), "/wt");
  assert.equal(at("Bash", { command: "npm ci\n--more" }), "명령 실행: npm ci");
  assert.equal(at("Read", { file_path: "/wt/package.json" }), "파일 읽기: package.json");
  assert.equal(at("Write", { file_path: "/srv/fieldtest/data/recipe-draft/recipe.json" }), "파일 쓰기: recipe-draft/recipe.json");
  assert.equal(at("Grep", { pattern: "playwright" }), "코드 검색: playwright");
  assert.equal(at("mcp__playwright__browser_navigate", { url: "http://127.0.0.1:3200/" }), "브라우저: http://127.0.0.1:3200/ 열기");
  assert.equal(at("mcp__playwright__browser_take_screenshot", {}), "브라우저: 스크린샷");
  assert.equal(at("TodoWrite", { todos: [{ status: "completed", activeForm: "읽기" }, { status: "in_progress", activeForm: "레시피 검증 중" }] }), "레시피 검증 중");
  assert.equal(activityOf({ type: "result" }, "/wt"), null);
  assert.equal(activityOf({ type: "assistant", message: { content: [{ type: "text", text: "생각" }] } }, "/wt"), null);
});

test("the stream is read by whole lines, across chunks, skipping lines that are not JSON", async () => {
  const { activityStream } = await import("../lib/engines.mjs");
  const seen = [];
  const feed = activityStream("/wt", (t) => seen.push(t));
  const line = JSON.stringify(toolEvent("Bash", { command: "ls" }));
  feed(Buffer.from(line.slice(0, 10)));
  feed(Buffer.from(`${line.slice(10)}\nnot json\n`));
  assert.deepEqual(seen, ["명령 실행: ls"]);
});
