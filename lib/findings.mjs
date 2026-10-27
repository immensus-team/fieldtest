// Free exploration (design §4): a use session writes what it did, a judge session turns the steps
// that went wrong into findings, and the exploration lane fixes the open findings one at a time.
// sessions/<id>/ keeps each exploration; findings/F-xxxx.json each finding.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RECENT_GOALS, paths } from "./config.mjs";
import { readJson, writeJson } from "./store.mjs";

export const FINDING_STATUSES = ["open", "fixing", "ticketed", "dropped", "blocked"];
const SEVERITY_ORDER = ["high", "medium", "low"];

export function listFindings() {
  if (!existsSync(paths.findings)) return [];
  return readdirSync(paths.findings)
    .filter((f) => /^F-\d+\.json$/.test(f))
    .sort()
    .map((f) => readJson(join(paths.findings, f), null))
    .filter(Boolean);
}

export function readFinding(id) {
  return readJson(join(paths.findings, `${id}.json`), null);
}

export function createFinding(finding) {
  mkdirSync(paths.findings, { recursive: true, mode: 0o2775 });
  const max = listFindings().reduce((n, f) => Math.max(n, Number(f.id.slice(2))), 0);
  const id = `F-${String(max + 1).padStart(4, "0")}`;
  const now = new Date().toISOString();
  const record = { id, status: "open", ...finding, createdAt: now, updatedAt: now };
  writeJson(join(paths.findings, `${id}.json`), record);
  return record;
}

export function updateFinding(id, change) {
  const current = readFinding(id);
  if (!current) throw new Error(`${id}: no such finding`);
  const next = { ...current, ...change, updatedAt: new Date().toISOString() };
  if (!FINDING_STATUSES.includes(next.status)) throw new Error(`${id}: unknown status ${next.status}`);
  writeJson(join(paths.findings, `${id}.json`), next);
  return next;
}

// The next finding to work on: the most severe, then the oldest. Proposals wait while the day's
// proposal cap is used up (proposals: false).
export function nextOpenFinding(findings = listFindings(), { proposals = true } = {}) {
  const rank = (f) => SEVERITY_ORDER.indexOf(f.severity);
  return (
    findings
      .filter((f) => f.status === "open" && (proposals || f.track !== "propose"))
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0] ?? null
  );
}

// A restart drops the work in progress (design §3), so a finding being fixed is open again.
export function reopenFixing() {
  for (const f of listFindings()) if (f.status === "fixing") updateFinding(f.id, { status: "open" });
}

export function listSessions(limit = Infinity) {
  if (!existsSync(paths.sessions)) return [];
  return readdirSync(paths.sessions)
    .filter((n) => /^\d+$/.test(n))
    .sort()
    .slice(-limit)
    .map((id) => ({ id, ...readJson(join(paths.sessions, id, "session.json"), {}) }));
}

export function recentGoals(limit = RECENT_GOALS) {
  return listSessions()
    .filter((s) => s.goal)
    .slice(-limit)
    .map((s) => `- ${s.goal}${s.persona ? ` (${s.persona})` : ""}`);
}
