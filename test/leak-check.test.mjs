import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leakCheck, readPatterns } from "../scripts/leak-check.mjs";

const tree = () => {
  const root = mkdtempSync(join(tmpdir(), "ft-leak-"));
  mkdirSync(join(root, "lib"));
  return root;
};

test("a real-looking token is found; a test placeholder is not", () => {
  const root = tree();
  // Built at run time so this file itself holds no token-shaped string.
  const token = ["xoxb", "123456789012", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-");
  writeFileSync(join(root, "lib", "a.mjs"), `const t = "${token}";\nconst fake = "xoxb-test";\n`);
  assert.deepEqual(leakCheck(root, []).map((h) => [h.file, h.line]), [["lib/a.mjs", 1]]);
});

test("a name from the pattern file is found, case-insensitively", () => {
  const root = tree();
  writeFileSync(join(root, "lib", "b.mjs"), "// fine\n// made for ACME Corp\n");
  const hits = leakCheck(root, [/acme corp/i]);
  assert.deepEqual(hits.map((h) => [h.file, h.line, h.pattern]), [["lib/b.mjs", 2, "acme corp"]]);
});

test("binary files and node_modules are skipped", () => {
  const root = tree();
  writeFileSync(join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0x61, 0x63, 0x6d, 0x65]));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "x.js"), "acme corp");
  assert.deepEqual(leakCheck(root, [/acme/i]), []);
});

test("pattern files skip comments and blank lines", () => {
  const root = tree();
  writeFileSync(join(root, "p.txt"), "# comment\n\nacme(?!-ok)\n");
  const [p] = readPatterns(join(root, "p.txt"));
  assert.ok(p.test("ACME"));
  assert.ok(!p.test("acme-ok"));
});
