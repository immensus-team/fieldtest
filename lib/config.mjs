import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readInstall } from "./install.mjs";

export const TOOL_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const INSTALL = readInstall();
export const DATA_DIR = process.env.FIELDTEST_DATA ?? INSTALL.data;
export const APPROVED_DIR = process.env.FIELDTEST_APPROVED ?? INSTALL.approved;
// GitHub mirror owned by the human. The agent's only source of the repository; it has no GitHub login.
export const MIRROR = process.env.FIELDTEST_MIRROR ?? INSTALL.mirror;
// The human's tokens, queues and maps (Slack, commands). Per user, so the agent never reads them.
export const CONFIG_DIR = join(homedir(), ".config", "fieldtest");

export const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83";

// Limits from the design: approval-waiting cap, retries, PR fix rounds, backoff.
export const MAX_APPROVAL_WAITING = 10;
export const MAX_FIX_TRIES = 3; // first try + 2 retries
// Safety cap on PR fix rounds of every kind. A repeated Codex finding is judged by the fix agent, not counted here.
export const MAX_PR_ROUNDS = 10;
export const REPRO_PASSES = 3;
// A use session gets this many recent goals so it picks a new one.
export const RECENT_GOALS = 20;
export const BACKOFF_MS = [15, 30, 60].map((m) => m * 60 * 1000);
export const IDLE_WAIT_MS = 10 * 60 * 1000;

// Change size above which a candidate goes to a human instead of review. New spec files don't count toward lines.
export const MAX_CHANGED_FILES = 8;
export const MAX_CHANGED_LINES = 300;
// Open tickets with one root cause that start a group: one PR that fixes the cause at its source and
// every other place it shows up. A group changes shared code across screens, so it gets more room.
export const GROUP_MIN_TICKETS = 3;
export const GROUP_LIMITS = { files: 30, lines: 1500 };
// A feature proposal (2026-10-26): the human approves its spec before any code, then the spec is built
// in one PR. At most this many proposals a day reach the human, so they read each one.
export const PROPOSALS_PER_DAY = 2;
export const PROPOSAL_LIMITS = { files: 15, lines: 800 };

// `fieldtest watch` runs every minute for Slack commands; PR state is read this often.
export const PR_CHECK_MS = 5 * 60 * 1000;

export const TIMEOUTS = {
  use: 60 * 60 * 1000,
  judge: 60 * 60 * 1000,
  implement: 90 * 60 * 1000,
  group: 180 * 60 * 1000,
  cause: 5 * 60 * 1000,
  propose: 45 * 60 * 1000,
  review: 45 * 60 * 1000,
  prFix: 60 * 60 * 1000,
  install: 15 * 60 * 1000,
  check: 30 * 60 * 1000,
  e2e: 20 * 60 * 1000,
};

export const paths = {
  tickets: join(DATA_DIR, "tickets"),
  runs: join(DATA_DIR, "runs"),
  sessions: join(DATA_DIR, "sessions"),
  findings: join(DATA_DIR, "findings"),
  // Spotlight skips a folder whose name ends in .noindex; it indexed every install otherwise.
  worktrees: join(DATA_DIR, "worktrees.noindex"),
  repo: join(DATA_DIR, "repo"),
  run: join(DATA_DIR, "run"),
  baseChecks: join(DATA_DIR, "base-checks"),
  state: join(DATA_DIR, "state.json"),
  // Approved recipe and history (human-owned, outside the data directory), and the agent's draft.
  recipe: join(APPROVED_DIR, "recipe"),
  recipeDraft: join(DATA_DIR, "recipe-draft"),
  recipeHistory: join(APPROVED_DIR, "recipe-history"),
  // Real keys the installer gave (human-owned, staff-readable 640): the app needs them, the agent reads them.
  recipeSecrets: join(APPROVED_DIR, "recipe-secrets.env"),
  // Bootstrap and repair progress; both accounts write it.
  recipeState: join(DATA_DIR, "run", "recipe-state.json"),
  // The setup wizard's progress (human-owned, so the agent can't mark steps done).
  setup: join(APPROVED_DIR, "setup.json"),
  lock: join(DATA_DIR, "run", "loop.lock"),
  prompts: join(TOOL_DIR, "prompts"),
  schemas: join(TOOL_DIR, "schemas"),
};

// Optional overrides in <data>/config.json: { "implementModel": "...", "reviewModel": "...", "codexEffort": "...", "cardModel": "...", "myClone": "..." }
export function settings() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
  } catch {}
  return {
    implementModel: file.implementModel ?? "claude-opus-5-5",
    reviewModel: file.reviewModel ?? null, // null = Codex config default
    // The agent's Codex has no config of its own, and the CLI default effort is "none". Match the human's "high".
    codexEffort: file.codexEffort ?? "high",
    cardModel: file.cardModel ?? "claude-sonnet-5-5",
    myClone: file.myClone ?? INSTALL.clone,
  };
}
