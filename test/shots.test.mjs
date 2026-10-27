import assert from "node:assert/strict";
import { test } from "node:test";
import { shotRows } from "../lib/shots.mjs";

test("screenshots pair before and after, narrow screens first and light before dark", () => {
  const names = ["after-1440-dark.png", "before-1440-dark.png", "after-390-light.png", "before-390-light.png", "before-390-dark.png", "after-390-dark.png", "before-only.png", "notes.txt"];
  const rows = shotRows(names.map((n) => `/x/${n}`));
  assert.deepEqual(rows.map((r) => r.label), ["390px · 라이트", "390px · 다크", "1440px · 다크", "only"]);
  assert.deepEqual([rows[0].before, rows[0].after], ["/x/before-390-light.png", "/x/after-390-light.png"]);
  assert.equal(rows[3].after, undefined);
});
