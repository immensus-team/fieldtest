// Worktrees of the agent's clone, one directory per lane, and the fetch from the mirror.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.mjs";
import { stopDemo } from "./demo.mjs";
import { git, run } from "./exec.mjs";
import { LANES, currentLane } from "./lane.mjs";

export async function fetchOrigin() {
  await git(paths.repo, ["fetch", "--prune", "--quiet", "origin"]);
}

// Worktrees live under the lane's own directory, so one lane's cleanup never removes the other's.
const laneWorktrees = () => join(paths.worktrees, currentLane()?.name ?? "main");

export async function addWorktree(name, ref) {
  const wt = join(laneWorktrees(), name);
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(laneWorktrees(), { recursive: true });
  await git(paths.repo, ["worktree", "add", "--detach", "--force", wt, ref]);
  return wt;
}

export async function removeWorktree(wt) {
  if (!wt) return;
  stopDemo();
  await run("git", ["worktree", "remove", "--force", wt], { cwd: paths.repo });
  rmSync(wt, { recursive: true, force: true });
  await run("git", ["worktree", "prune"], { cwd: paths.repo });
}

// The calling lane's worktrees; outside a lane (loop start) every worktree, old flat ones included.
export async function cleanWorktrees() {
  const lane = currentLane();
  const root = lane ? laneWorktrees() : paths.worktrees;
  mkdirSync(root, { recursive: true });
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const nested = !lane && Object.values(LANES).some((l) => l.name === name);
    if (nested) for (const sub of readdirSync(dir)) await removeWorktree(join(dir, sub));
    else await removeWorktree(dir);
  }
  await run("git", ["worktree", "prune"], { cwd: paths.repo });
}
