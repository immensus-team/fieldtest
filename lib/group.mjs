// Tickets with one root cause, fixed together. Every open ticket gets a cause key; once
// GROUP_MIN_TICKETS open tickets share one, a group ticket takes them over. Its implementer fixes the
// cause at its source, finds the other places the same cause shows up, and makes one PR. The human
// decides on the group alone; when its PR merges, the tickets it took over close with it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GROUP_MIN_TICKETS, TIMEOUTS, settings } from "./config.mjs";
import { currentRecipe } from "./recipe.mjs";
import { loadSchema, renderPrompt, runClaudePlain } from "./engines.mjs";
import { loadScreens } from "./screens.mjs";
import { STATUSES, createTicket, nextTicketId, readTicket, ticketDir, transition } from "./store.mjs";

// Single tickets a group may take over: waiting for the human's first decision.
const OPEN = ["awaiting", "needs-human"];
// A group that already exists for a cause. New tickets of that cause join it only while it waits for
// the human's first decision; joining sends it back to be rebuilt with them.
const ACTIVE = ["grouping", "revising", "awaiting", "needs-human"];
const JOINABLE = ["awaiting", "needs-human"];
const SEVERITY = ["high", "medium", "low", "trivial"];

export const causeOf = (t) => t.group?.cause ?? t.cause ?? null;

export function needsCause(t) {
  return !t.group && !t.cause && OPEN.includes(t.status);
}

// Causes already named, so a new ticket with the same cause gets the same key.
export function knownCauses(tickets) {
  const seen = new Map();
  for (const t of tickets) {
    const cause = causeOf(t);
    if (cause && !seen.has(cause.key)) seen.set(cause.key, cause.summary);
  }
  return seen.size ? [...seen].map(([key, summary]) => `- \`${key}\`: ${summary}`).join("\n") : "없음";
}

export async function classifyCause(t, tickets) {
  const dir = ticketDir(t.id);
  const r = await runClaudePlain({
    cwd: dir,
    prompt: renderPrompt("cause", { causes: knownCauses(tickets), ticket: readFileSync(join(dir, "ticket.md"), "utf8") }),
    schema: loadSchema("cause"),
    model: settings().cardModel,
    logFile: join(dir, "cause.log"),
    timeoutMs: TIMEOUTS.cause,
  });
  if (!r.ok) throw new Error(`${t.id} 원인 분류 실패: ${r.error}`);
  // The human may have acted meanwhile; the cause is kept whatever the status is now.
  transition(t.id, STATUSES, { cause: { key: r.json.key, summary: r.json.summary } });
  return { result: "cause", ticket: t.id, cause: r.json.key };
}

// What grouping does next: join new tickets to their cause's group, or start a group once enough open
// tickets share a cause. Null when there is nothing to do.
export function groupPlan(tickets) {
  const byKey = new Map();
  for (const t of tickets) {
    if (t.group || !t.cause || !OPEN.includes(t.status) || t.groupRejected) continue;
    byKey.set(t.cause.key, [...(byKey.get(t.cause.key) ?? []), t]);
  }
  for (const [key, singles] of byKey) {
    const group = tickets.find((g) => g.group?.cause.key === key && ACTIVE.includes(g.status));
    if (group) {
      if (JOINABLE.includes(group.status)) return { join: group.id, members: singles.map((t) => t.id) };
      continue;
    }
    if (singles.length >= GROUP_MIN_TICKETS) return { cause: singles[0].cause, members: singles.map((t) => t.id) };
  }
  return null;
}

function takeOver(groupId, ids) {
  for (const id of ids) {
    const t = readTicket(id);
    transition(id, OPEN, { status: "grouped", groupId, groupFrom: t.status });
  }
}

export function applyGroupPlan(tickets, plan) {
  if (plan.join) {
    const group = tickets.find((t) => t.id === plan.join);
    takeOver(group.id, plan.members);
    transition(group.id, JOINABLE, { status: "grouping", group: { ...group.group, members: [...group.group.members, ...plan.members] } });
    return { result: "group-joined", ticket: group.id, members: plan.members };
  }
  const members = plan.members.map((id) => tickets.find((t) => t.id === id));
  const id = nextTicketId(tickets);
  const severity = SEVERITY.find((s) => members.some((t) => t.severity === s)) ?? "low";
  const now = new Date().toISOString();
  createTicket({
    id,
    screen: members[0].screen,
    status: "grouping",
    title: `${plan.cause.summary} (${members.length}건 묶음)`,
    // A group goes to the 추가 board only when every member is an improvement.
    track: members.every((t) => t.track === "improve") ? "improve" : "fix",
    kind: null,
    severity,
    attempt: 0,
    base: null,
    candidate: null,
    branch: null,
    group: { cause: plan.cause, members: plan.members },
    implement: { engine: "claude", model: settings().implementModel },
    review: { engine: "codex", model: settings().reviewModel },
    feedback: null,
    rejectReason: null,
    pr: null,
    createdAt: now,
    updatedAt: now,
  });
  takeOver(id, plan.members);
  return { result: "group", ticket: id, members: plan.members };
}

// A rejected group hands its tickets back. They keep their cause but never group again, or the same
// group would form at once.
export function releaseMembers(group) {
  for (const id of group.group.members) {
    const t = readTicket(id);
    if (t?.status !== "grouped") continue;
    transition(id, "grouped", { status: t.groupFrom ?? "awaiting", groupId: null, groupFrom: null, groupRejected: true });
  }
}

// The group's PR merged or closed: its tickets end the same way.
export function closeMembers(group, status) {
  for (const id of group.group.members) {
    if (readTicket(id)?.status !== "grouped") continue;
    transition(id, "grouped", {
      status,
      resolvedBy: status === "merged" ? { number: group.pr.number, url: group.pr.url } : null,
    });
  }
}

// The screen a ticket works in. A group spans its tickets' screens and may change any code the recipe allows.
export function ticketScreen(t, screens = loadScreens()) {
  const own = screens.find((s) => s.id === t.screen);
  if (!t.group) return own;
  const members = t.group.members.map(readTicket).filter(Boolean);
  const used = [...new Set([t.screen, ...members.map((m) => m.screen)])].map((id) => screens.find((s) => s.id === id)).filter(Boolean);
  const unique = (list) => [...new Set(list)];
  return {
    id: own.id,
    url: own.url,
    specs: unique(used.flatMap((s) => s.specs)),
    paths: unique([...currentRecipe().paths.allowed, ...used.flatMap((s) => s.paths)]),
    mission: "",
  };
}
