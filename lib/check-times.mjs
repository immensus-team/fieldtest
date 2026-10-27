// How long the repository checks take, kept to compare instance types over time.
// Each recipe check appends one line; the dashboard's 서버 view shows medians per vCPU count.
import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cpus, loadavg } from "node:os";
import { paths } from "./config.mjs";
import { currentRecipe } from "./recipe.mjs";

const KEEP_PER_GROUP = 30;

export function checkTimesFile() {
  return join(paths.run, "check-times.jsonl");
}

// Turbo's closing summary ("Cached:    2 cached, 3 total") and whether the app package (named like the
// recipe's app root), where nearly all the time goes, ran or was replayed ("@acme/web:test: cache miss,
// executing …"). A check without turbo has neither.
export function turboCache(stdout, app) {
  const m = stdout.match(/Cached:\s+(\d+) cached, (\d+) total/);
  if (!m) return null;
  const own = [...stdout.matchAll(/^(\S+):\S+: cache (hit|miss)/gm)].filter(([, pkg]) => pkg.split("/").pop() === app).map(([, , state]) => state);
  return { cached: Number(m[1]), total: Number(m[2]), web: own.length ? (own.includes("miss") ? "miss" : "hit") : null };
}

// Where a check ran, from its log: main's base check starts from a fresh worktree; a candidate's gate
// reuses incremental build output (a typecheck takes 5 s there, 20 s on main), so only base checks are compared.
export function sourceOf(logFile = "") {
  if (logFile.includes("/base-checks/")) return "base";
  if (logFile.includes("/merge-checks/")) return "merge";
  return "gate";
}

export async function timed(check, logFile, fn) {
  const started = Date.now();
  const r = await fn();
  const cache = turboCache(r.stdout ?? "", basename(currentRecipe().app.root));
  const line = {
    at: new Date().toISOString(),
    check,
    from: sourceOf(logFile),
    ms: Date.now() - started,
    ok: r.code === 0,
    cores: cpus().length,
    load: Math.round(loadavg()[0] * 100) / 100,
    ...(cache && { cached: cache.cached, tasks: cache.total, web: cache.web }),
  };
  try {
    appendFileSync(checkTimesFile(), `${JSON.stringify(line)}\n`);
  } catch {}
  return r;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// Lines taken from older check logs have no load.
function loads(runs) {
  const xs = runs.map((r) => r.load).filter(Number.isFinite);
  return xs.length ? median(xs.map((l) => Math.round(l * 100))) / 100 : null;
}

// Passed base checks in which the web package ran (a replayed one takes milliseconds), newest per group.
export function summarizeCheckTimes(text) {
  const groups = new Map();
  for (const raw of text.split("\n")) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!e.ok || e.from !== "base" || e.web === "hit" || (e.tasks && e.cached === e.tasks)) continue;
    const key = `${e.cores}:${e.check}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return [...groups.values()].map((all) => {
    const runs = all.slice(-KEEP_PER_GROUP);
    const last = runs.at(-1);
    return {
      cores: last.cores,
      check: last.check,
      runs: runs.length,
      medianMs: median(runs.map((r) => r.ms)),
      lastMs: last.ms,
      lastAt: last.at,
      medianLoad: loads(runs),
    };
  });
}

export function checkTimes() {
  try {
    return summarizeCheckTimes(readFileSync(checkTimesFile(), "utf8"));
  } catch {
    return [];
  }
}
