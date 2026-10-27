// What the loop decides from the recipe's state (design §8.3, §8.4): when exploration waits, when the
// e2e setup ticket is made and what it may change.
import { createHash } from "node:crypto";

const SETUP_PATHS = ["**/package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "**/playwright.config.*"];

// The setup ticket installs Playwright, so it alone may touch package files and the e2e directory.
export function setupScope(screen, recipe) {
  const e2e = `${recipe.e2e.dir.replace(/\/+$/, "")}/**`;
  const opened = [...SETUP_PATHS, e2e];
  const paths = [...new Set([...screen.paths, ...opened])];
  return { ...screen, paths, ceiling: paths, forbidden: recipe.paths.forbidden.filter((p) => !opened.includes(p)) };
}

// Why exploration waits, or null. Repairs and approvals come before new findings: tickets made on a
// broken recipe would be judged against the wrong app.
export function exploreBlocked(tickets, state) {
  if (state.repair) return `실행 지침 수리 대기: ${state.repair.reason.split("\n")[0]}`;
  if (state.stage === "failed") return `실행 지침 검증 실패: ${String(state.error ?? "").split("\n")[0]}`;
  if (state.awaitingApproval?.length) return `실행 지침 변경 승인 대기 (${state.awaitingApproval.join(", ")})`;
  const setup = tickets.find((t) => t.setup && !["merged", "rejected", "closed"].includes(t.status));
  if (setup) return `e2e 준비 PR을 기다림 (${setup.id})`;
  return null;
}

export const setupTicketNeeded = (tickets, state) => Boolean(state.needsE2eSetup && state.e2eSetup?.spec && !tickets.some((t) => t.setup));

// Base checks are cached per base commit and recipe: a repaired recipe checks the same commit again.
export const recipeHash = (recipe) => createHash("sha1").update(JSON.stringify({ ...recipe, dir: undefined })).digest("hex").slice(0, 12);
