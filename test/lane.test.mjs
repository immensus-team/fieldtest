import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FIELDTEST_DATA = mkdtempSync(join(tmpdir(), "uq-lane-"));
const { useFixtureRecipe } = await import("./helpers/recipe.mjs");
useFixtureRecipe();
const { LANES, demoPort, inLane, laneEnv } = await import("../lib/lane.mjs");
const { run } = await import("../lib/exec.mjs");
const { staleRequest } = await import("../lib/agent.mjs");

test("each lane hands its own ports to the processes it starts", async () => {
  assert.deepEqual(laneEnv(), {});
  await inLane(LANES.explore, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(demoPort(), 3210);
    const r = await run("/bin/sh", ["-c", 'echo "$E2E_PORT $FIELDTEST_DEMO_PORT"']);
    assert.equal(r.stdout.trim(), "3110 3210");
  });
  assert.equal(demoPort(), 3200);
});

test("a fix request for an older PR head is dropped unless it carries the human's feedback", () => {
  const req = { head: "389c34b7", humanFeedback: null, ciFailures: [{ name: "Vercel" }] };
  assert.equal(staleRequest(req, "389c34b7"), false);
  assert.equal(staleRequest(req, "ca89d8e5"), true);
  assert.equal(staleRequest({ ...req, humanFeedback: "원인을 다시 확인해" }, "ca89d8e5"), false);
});
