import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, cpuPercent, parseCpuLine, parseMeminfo, parseProcStat, parseShow, sinceOf } from "../lib/host.mjs";

test("host CPU percent comes from the busy share of two /proc/stat samples", () => {
  const a = parseCpuLine("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3");
  const b = parseCpuLine("cpu  160 0 140 760 140 0 0 0 0 0\n");
  assert.deepEqual(a, { idle: 800, total: 1000 });
  assert.equal(cpuPercent(a, b), 50);
  assert.equal(cpuPercent(a, a), 0);
});

test("meminfo values are bytes", () => {
  const m = parseMeminfo("MemTotal:       32000000 kB\nMemFree:  1 kB\nMemAvailable:   30000000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n");
  assert.equal(m.total, 32000000 * 1024);
  assert.equal(m.available, 30000000 * 1024);
  assert.equal(m.swapTotal, 0);
});

test("a process stat line parses past a command name with spaces and parentheses", () => {
  const fields = ["S", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "250", "50", "13", "14", "15", "16", "17", "18", "9000", "20", "512"];
  const s = parseProcStat(`42 (Web Content (x)) ${fields.join(" ")}`);
  assert.deepEqual(s, { ticks: 300, start: 9000, rssPages: 512 });
});

test("systemctl show blocks become one object per unit", () => {
  const units = parseShow("Id=fieldtest.service\nActiveState=active\nSubState=running\n\nId=fieldtest-web.service\nActiveState=failed\nResult=exit-code\n");
  assert.equal(units.length, 2);
  assert.equal(units[1].Id, "fieldtest-web.service");
  assert.equal(units[1].ActiveState, "failed");
  assert.equal(sinceOf("@1792779144"), "2026-10-23T18:12:24.000Z");
  assert.equal(sinceOf(""), null);
});

test("processes are grouped by what they run", () => {
  assert.equal(classify("/home/fieldtest-agent/.cache/ms-playwright/chromium-1247/chrome-linux-arm64/chrome --type=renderer").kind, "browser");
  assert.equal(classify("next-server (v16.3.4)").kind, "next");
  assert.equal(classify("claude -p --output-format json").kind, "claude");
  assert.equal(classify("node /srv/fieldtest/runtime/node/bin/codex exec --json").kind, "codex");
  assert.equal(classify("next-build (v16.3.4)").kind, "next");
  assert.equal(classify("node /x/.next/build/chunks/pool_entry-[turbopack-node]_transforms.js").kind, "next");
  assert.equal(classify("node --test-concurrency=4 --test src").kind, "check");
  assert.equal(classify("turbo run build").kind, "check");
  assert.equal(classify("node /x/bin/pnpm run build").kind, "check");
  assert.equal(classify("node /srv/fieldtest/code/bin/fieldtest.mjs web").kind, "fieldtest");
  assert.equal(classify("bash").kind, "other");
});
