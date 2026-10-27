// Short card for people: summary, expected and actual behavior, cause and fix, written from
// ticket.md in plain words. The agent loop writes it (it has the Claude login); the dashboard and Slack show
// only the card. A card belongs to one version of ticket.md, so a revise makes a new one.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "./config.mjs";
import { loadSchema, renderPrompt, runClaudePlain } from "./engines.mjs";
import { readJson, ticketDir, writeJson } from "./store.mjs";

const TERMINAL = ["merged", "rejected", "closed"];

function ticketHash(id) {
  const file = join(ticketDir(id), "ticket.md");
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}

// The card for the current ticket.md, or null when there is none yet.
export function readCard(id) {
  const card = readJson(join(ticketDir(id), "card.json"), null);
  return card && card.hash === ticketHash(id) ? card : null;
}

export function needsCard(t) {
  return !TERMINAL.includes(t.status) && ticketHash(t.id) !== null && !readCard(t.id);
}

export async function makeCard(t) {
  const dir = ticketDir(t.id);
  const hash = ticketHash(t.id);
  const r = await runClaudePlain({
    cwd: dir,
    prompt: renderPrompt("card", { ticket: readFileSync(join(dir, "ticket.md"), "utf8") }),
    schema: loadSchema("card"),
    model: settings().cardModel,
    logFile: join(dir, "card.log"),
    timeoutMs: 5 * 60 * 1000,
  });
  if (!r.ok) throw new Error(`${t.id} 카드 작성 실패: ${r.error}`);
  writeJson(join(dir, "card.json"), { hash, ...r.json });
  return { result: "card", ticket: t.id };
}
