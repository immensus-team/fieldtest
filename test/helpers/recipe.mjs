// Puts the fixture recipe (acme/shop) where the code under test reads the approved recipe.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = new URL("../fixtures/recipe", import.meta.url).pathname;

export function useFixtureRecipe(changes = {}) {
  // The approved recipe lives outside the data directory (human-owned); tests keep it next to their data.
  process.env.FIELDTEST_APPROVED ??= join(process.env.FIELDTEST_DATA, "..", `approved-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const dir = join(process.env.FIELDTEST_APPROVED, "recipe");
  cpSync(FIXTURE, dir, { recursive: true });
  const recipe = { ...JSON.parse(readFileSync(join(FIXTURE, "recipe.json"), "utf8")), ...changes };
  writeFileSync(join(dir, "recipe.json"), JSON.stringify(recipe, null, 2));
  return dir;
}

// A pnpm monorepo with the web app under apps/web, the shape most existing tests use.
export const MONOREPO = {
  app: { kind: "web", root: "apps/web" },
  checks: [
    { name: "Lint", command: "pnpm lint", stage: "fast" },
    { name: "Typecheck", command: "pnpm typecheck", stage: "fast" },
    { name: "Unit test", command: "pnpm test", stage: "full" },
    { name: "Build", command: "pnpm build", stage: "full" },
  ],
  e2e: { cwd: "apps/web", dir: "apps/web/e2e", playwright: "pnpm exec playwright", project: "chromium" },
  unit: { pattern: "apps/web/src/**/*.test.ts", cwd: "apps/web", run: "node scripts/test-run.mjs {files}" },
  paths: {
    allowed: ["apps/web/src/components/**", "apps/web/src/app/**", "apps/web/src/hooks/**", "apps/web/src/lib/**", "apps/web/e2e/**"],
    forbidden: ["**/package.json", "pnpm-lock.yaml", ".github/**", "**/AGENTS.md", "docs/**", "apps/web/src/app/api/**", "apps/web/src/server/**", "packages/**"],
  },
  autoRoute: { files: 3, lines: 80, copyCheck: true },
};
