// Stands in for `<recipe.e2e.playwright> test …` in the bootstrap tests. `--list` prints one test;
// `--config` runs the screen check by fetching each screen; anything else passes.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--list")) {
  console.log("  [chromium] › smoke.spec.ts:3:5 › smoke");
  process.exit(0);
}
const config = args.find((a) => a.startsWith("--config="))?.slice("--config=".length);
if (config) {
  const check = JSON.parse(readFileSync(join(dirname(resolve(config)), "screen-check.json"), "utf8"));
  const results = [];
  for (const s of check.screens) {
    const res = await fetch(`${check.baseURL}${s.url}`);
    const text = (await res.text()).replace(/<[^>]+>/g, "").trim();
    const shot = join(check.shotsDir, `${s.id}.png`);
    writeFileSync(shot, "png");
    results.push({ id: s.id, finalUrl: res.url, textLength: text.length, shot });
  }
  writeFileSync(check.results, JSON.stringify(results));
}
