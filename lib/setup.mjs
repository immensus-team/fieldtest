// The setup wizard's steps (design §5.1). Each step is done once its check passed; the state survives a
// closed page, and reopening a step voids only the steps built on it.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config.mjs";
import { readJson, writeJson } from "./store.mjs";

export const STEPS = ["server", "github", "repo", "claude", "codex", "slack", "bootstrap", "recipe", "start"];

// Steps that must run again when this one changes.
export const DEPENDS = {
  server: [],
  github: ["repo", "bootstrap", "recipe"],
  repo: ["bootstrap", "recipe"],
  claude: ["bootstrap", "recipe"],
  codex: [],
  // start.sh turns the Slack service on, and restarts it with new tokens.
  slack: ["start"],
  bootstrap: ["recipe"],
  recipe: [],
  start: [],
};

const file = () => paths.setup;

export function readSetup() {
  const s = readJson(file(), {});
  return { steps: Object.fromEntries(STEPS.map((id) => [id, { done: false, at: null, info: {}, ...(s.steps?.[id] ?? {}) }])) };
}

function save(s) {
  mkdirSync(dirname(file()), { recursive: true });
  writeJson(file(), s);
  // Processes run under umask 002 for the shared data directory; this file is the human's alone.
  chmodSync(file(), 0o644);
  return s;
}

export function completeStep(id, info = {}) {
  const s = readSetup();
  s.steps[id] = { done: true, at: new Date().toISOString(), info };
  return save(s);
}

// Reopens `id` and every step built on it.
export function invalidate(id) {
  const s = readSetup();
  for (const step of [id, ...DEPENDS[id]]) s.steps[step] = { ...s.steps[step], done: false };
  return save(s);
}

export const currentStep = (s) => STEPS.find((id) => !s.steps[id].done) ?? null;
export const setupDone = () => currentStep(readSetup()) === null;
