import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { screenText } from "../lib/vt.mjs";

const raw = (name) => readFileSync(new URL(`./fixtures/device/${name}.raw`, import.meta.url), "utf8");

test("colors and terminal queries drop out of gh's screen", () => {
  assert.match(screenText(raw("gh")), /! First copy your one-time code: ABCD-1234\nPress Enter to open https:\/\/github\.com\/login\/device in your browser\.\.\./);
});

test("Claude's cursor-positioned words come back as one line of text", () => {
  const text = screenText(raw("claude"));
  assert.match(text, /Welcome to Claude Code v2\.1\.310/);
  assert.match(text, /This will guide you through long-lived \(1-year\) auth token setup for your/);
  assert.match(text, /Paste code here if prompted >/);
});

test("cursor moves, erase and carriage return land where a terminal puts them", () => {
  assert.equal(screenText("abc\x1b[2Gx\x1b[5Gy"), "axc y");
  assert.equal(screenText("hello\rJ\x1b[K"), "J");
  assert.equal(screenText("a\x1b[3Cb"), "a   b");
  assert.equal(screenText("\x1b[2;3Hz"), "\n  z");
});
