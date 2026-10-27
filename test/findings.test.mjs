import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-findings-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { paths } = await import("../lib/config.mjs");
const { writeJson } = await import("../lib/store.mjs");
const { createFinding, listFindings, nextOpenFinding, recentGoals, reopenFixing, updateFinding } = await import("../lib/findings.mjs");

test("the most severe open finding is fixed first, then the oldest", () => {
  createFinding({ severity: "low", title: "a" });
  createFinding({ severity: "medium", title: "b" });
  createFinding({ severity: "medium", title: "c" });
  assert.deepEqual(listFindings().map((f) => f.id), ["F-0001", "F-0002", "F-0003"]);
  assert.equal(nextOpenFinding().id, "F-0002");
  updateFinding("F-0002", { status: "ticketed", ticket: "QA-0100" });
  assert.equal(nextOpenFinding().id, "F-0003");
  assert.throws(() => updateFinding("F-0003", { status: "gone" }), /unknown status/);
});

test("a restart reopens the finding being fixed", () => {
  updateFinding("F-0003", { status: "fixing" });
  reopenFixing();
  assert.equal(listFindings().find((f) => f.id === "F-0003").status, "open");
});

test("recent goals come from the newest explorations", () => {
  for (let i = 0; i < 25; i++) {
    mkdirSync(join(paths.sessions, String(1000 + i)), { recursive: true });
    writeJson(join(paths.sessions, String(1000 + i), "session.json"), i === 3 ? { status: "failed" } : { goal: `목표 ${i}`, persona: "과장" });
  }
  const goals = recentGoals();
  assert.equal(goals.length, 20);
  assert.equal(goals.at(-1), "- 목표 24 (과장)");
  assert.ok(!goals.includes("- 목표 3 (과장)"));
});
