#!/usr/bin/env node
// Checks a tree before it goes public: real-looking secrets, and names from a pattern file that is
// itself never published (one regular expression per line).
//   node scripts/leak-check.mjs <tree> [--patterns <file>]
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Shapes of real credentials, not of the short placeholders tests use ("xoxb-test").
const SECRETS = [
  /xox[abpre]-\d{8,}-[\w-]{10,}/,
  /xapp-\d-[A-Z0-9]{8,}-/,
  /gh[pousr]_[A-Za-z0-9]{36}/,
  /github_pat_\w{60,}/,
  /sk-ant-[a-z]{3}\d{2}-[\w-]{40,}/,
  /sk-[A-Za-z0-9]{40,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

export function readPatterns(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* files(join(dir, e.name));
    } else if (e.isFile()) yield join(dir, e.name);
  }
}

// [{ file, line, pattern }] for every line of every text file that matches.
export function leakCheck(root, patterns) {
  const hits = [];
  for (const file of files(root)) {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue;
    buf
      .toString("utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const p of [...SECRETS, ...patterns]) if (p.test(text)) hits.push({ file: relative(root, file), line: i + 1, pattern: p.source });
      });
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, flag, patternFile] = process.argv.slice(2);
  if (!root) {
    console.error("usage: leak-check.mjs <tree> [--patterns <file>]");
    process.exit(2);
  }
  const hits = leakCheck(root, flag === "--patterns" ? readPatterns(patternFile) : []);
  for (const h of hits) console.log(`${h.file}:${h.line}  /${h.pattern}/`);
  console.log(hits.length ? `${hits.length}건` : "0건");
  process.exit(hits.length ? 1 : 0);
}
