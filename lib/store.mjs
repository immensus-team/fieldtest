import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_APPROVAL_WAITING, paths } from "./config.mjs";

// Tickets waiting on the human (each gets a Slack message).
export const HUMAN_WAITING = ["awaiting", "needs-human", "proposal", "final-review"];
// The 승인 대기 column. New exploration stops while it holds MAX_APPROVAL_WAITING tickets.
// final-review is left out: only tickets the human approved reach it, so the human sets that flow.
export const APPROVAL_WAITING = ["awaiting", "needs-human", "proposal"];
export const STATUSES = [
  "awaiting",
  "needs-human",
  // A feature proposal: a spec without code, waiting for the human to approve, revise or reject it.
  "proposal",
  "revising",
  // A group ticket being built, and the tickets it took over.
  "grouping",
  "grouped",
  "rejected",
  "pr-review",
  "pr-fixing",
  "pr-push",
  "final-review",
  "merged",
  "closed",
];

export function ticketDir(id) {
  return join(paths.tickets, id);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Write to a temp file and rename, so the other process never reads half a file.
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o664 });
  renameSync(tmp, file);
}

export function readTicket(id) {
  return readJson(join(ticketDir(id), "status.json"), null);
}

export function listTickets() {
  if (!existsSync(paths.tickets)) return [];
  return readdirSync(paths.tickets)
    .filter((name) => /^QA-\d+$/.test(name))
    .sort()
    .map((id) => readTicket(id))
    .filter(Boolean);
}

export function nextTicketId(tickets = listTickets()) {
  const max = tickets.reduce((n, t) => Math.max(n, Number(t.id.slice(3))), 0);
  return `QA-${String(max + 1).padStart(4, "0")}`;
}

// A ticket on the automatic route is approved by watch within a minute, so it does not hold the loop.
export function approvalWaiting(tickets = listTickets()) {
  return tickets.filter((t) => APPROVAL_WAITING.includes(t.status) && !t.route?.auto).length;
}

export function overApprovalCap(tickets) {
  return approvalWaiting(tickets) >= MAX_APPROVAL_WAITING;
}

export function createTicket(ticket) {
  const dir = ticketDir(ticket.id);
  mkdirSync(dir, { recursive: true, mode: 0o2775 });
  writeJson(join(dir, "status.json"), ticket);
  return ticket;
}

// Each status has one owner (loop, watch or a human command). The owner only moves a
// ticket out of a status it expects, so the two processes never overwrite each other.
export function transition(id, from, change) {
  const file = join(ticketDir(id), "status.json");
  const current = readJson(file, null);
  if (!current) throw new Error(`${id}: no such ticket`);
  const allowed = Array.isArray(from) ? from : [from];
  if (!allowed.includes(current.status)) {
    throw new Error(`${id}: status is ${current.status}, expected ${allowed.join(" or ")}`);
  }
  const next = { ...current, ...(typeof change === "function" ? change(current) : change), updatedAt: new Date().toISOString() };
  if (!STATUSES.includes(next.status)) throw new Error(`${id}: unknown status ${next.status}`);
  writeJson(file, next);
  return next;
}

export function logRun(record) {
  mkdirSync(paths.runs, { recursive: true, mode: 0o2775 });
  const at = new Date().toISOString();
  const name = `${at.replace(/[:.]/g, "-")}-${record.ticket ?? record.finding ?? record.screen ?? (record.session ? "explore" : "loop")}.json`;
  writeJson(join(paths.runs, name), { at, ...record });
}

export function recentRuns(limit = 20) {
  if (!existsSync(paths.runs)) return [];
  return readdirSync(paths.runs)
    .sort()
    .slice(-limit)
    .map((f) => readJson(join(paths.runs, f), null))
    .filter(Boolean);
}

export function readState() {
  return readJson(paths.state, { screens: {}, failures: 0 });
}

export function writeState(state) {
  writeJson(paths.state, state);
}

// Board column of each status (Slack message header, dashboard).
export const STATUS_LABEL = {
  awaiting: "승인 대기",
  "needs-human": "승인 대기",
  proposal: "승인 대기",
  revising: "진행 중",
  grouping: "진행 중",
  grouped: "진행 중",
  "pr-review": "진행 중",
  "pr-fixing": "진행 중",
  "pr-push": "진행 중",
  "final-review": "최종 검토",
  merged: "종료",
  rejected: "종료",
  closed: "종료",
};

// Severity of a ticket, from the newest implement result when the ticket itself has none.
export function severityOf(t) {
  if (t.severity) return t.severity;
  const dir = join(ticketDir(t.id), "attempts", String(t.attempt));
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^implement-\d+\.json$/.test(f)).sort() : [];
  return files.length ? readJson(join(dir, files.at(-1)), {}).severity : undefined;
}
