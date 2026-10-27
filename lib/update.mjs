// Automatic updates: an install follows the public repo's release tags (vX.Y.Z), not its main. The
// human's timer checks every hour, waits for the agent to finish its task (at most MAX_WAIT_MS), then
// checks out the tag and runs setup/start.sh, which rebuilds and restarts everything together: new
// prompts with old loop code break. A release that does not come up is rolled back and skipped.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APPROVED_DIR, TOOL_DIR, paths } from "./config.mjs";
import { run } from "./exec.mjs";
import { readJson, readState, writeJson } from "./store.mjs";

export const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const RELEASE = /^v\d+\.\d+\.\d+$/;
const START_MS = 45 * 60 * 1000;

// Human-owned, next to the approved recipe: the agent must not mark a release as failed or applied.
export const updateFile = () => join(APPROVED_DIR, "update.json");

// Tags sorted newest first (git's version sort); release candidates and other tags are skipped.
export const newestTag = (tags) => tags.find((t) => RELEASE.test(t)) ?? null;

export function decide({ current, newest, busy, waitingSince = null, failed = null, now }) {
  if (!newest || newest === current || newest === failed) return { action: "none" };
  if (busy && (!waitingSince || now - Date.parse(waitingSince) < MAX_WAIT_MS)) return { action: "wait", reason: busy };
  return { action: "apply" };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // The bootstrap runs as the agent account: another user's process answers EPERM.
    return e.code === "EPERM";
  }
}

// What the agent is doing now, or null: a lane's task, or a bootstrap holding its lock.
export function currentBusy() {
  const lanes = Object.entries(readState().lanes ?? {}).filter(([, l]) => l?.task);
  if (lanes.length) return lanes.map(([name, l]) => `${name}: ${l.task}`).join(", ");
  const lock = join(paths.run, "bootstrap.lock");
  if (existsSync(lock) && alive(Number(readFileSync(lock, "utf8")))) return "실행 지침 만들기";
  return null;
}

async function servicesHealthy() {
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}` };
  const units = await run("systemctl", ["--user", "is-active", "fieldtest.service", "fieldtest-web.service"], { env });
  if (units.code !== 0) return false;
  const port = JSON.parse(readFileSync(process.env.FIELDTEST_INSTALL ?? "/etc/fieldtest/install.json", "utf8")).webPort ?? 4310;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    if (res?.ok) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

function save(state) {
  mkdirSync(dirname(updateFile()), { recursive: true });
  writeJson(updateFile(), state);
  chmodSync(updateFile(), 0o644);
}

// One check. now: apply without waiting for the agent (`fieldtest update --now`).
export async function update({ now = false, codeDir = TOOL_DIR, start = ["bash", join(codeDir, "setup", "start.sh")], healthy = servicesHealthy, busy = currentBusy, log = console.log } = {}) {
  const git = (args) => run("git", ["-C", codeDir, ...args]);
  const fetched = await git(["fetch", "--quiet", "--tags", "--force", "origin"]);
  if (fetched.code !== 0) throw new Error(`새 버전을 확인하지 못했다: ${fetched.stderr.trim()}`);
  const newest = newestTag((await git(["tag", "-l", "v*", "--sort=-v:refname"])).stdout.split("\n").filter(Boolean));
  const exact = await git(["describe", "--tags", "--exact-match", "HEAD"]);
  const current = exact.code === 0 ? exact.stdout.trim() : null;
  const st = readJson(updateFile(), {});
  const waitingSince = st.waiting?.tag === newest ? st.waiting.since : null;
  const d = decide({ current, newest, busy: now ? null : busy(), waitingSince, failed: st.failed ?? null, now: Date.now() });
  if (d.action === "none") {
    if (st.waiting) save({ ...st, waiting: null });
    return { action: "none", current };
  }
  if (d.action === "wait") {
    save({ ...st, waiting: { tag: newest, since: waitingSince ?? new Date().toISOString() } });
    log(`${newest} 업데이트 대기: ${d.reason}`);
    return d;
  }

  const prev = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const from = current ?? prev.slice(0, 7);
  const apply = async (ref) => {
    const co = await git(["checkout", "--quiet", "--detach", ref]);
    if (co.code !== 0) return co.stderr.trim();
    const r = await run(start[0], start.slice(1), { timeoutMs: START_MS });
    if (r.code !== 0) return (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
    return (await healthy()) ? null : "재시작한 서비스가 응답하지 않는다";
  };
  log(`${from} → ${newest} 업데이트`);
  const error = await apply(newest);
  const at = new Date().toISOString();
  if (!error) {
    save({ current: newest, last: { from, to: newest, at, ok: true }, waiting: null, failed: null });
    return { action: "applied", from, to: newest };
  }
  log(`${newest} 실패, 이전 버전(${from})으로 되돌린다: ${error}`);
  const back = await apply(prev);
  save({ current, last: { from, to: newest, at, ok: false, error, rolledBack: !back }, waiting: null, failed: newest });
  return { action: "rolled-back", error };
}

// Banner on the dashboard: a release that failed and was rolled back.
export function updateAlerts(st) {
  const last = st?.last;
  if (!last || last.ok) return [];
  const back = last.rolledBack ? `이전 버전(${last.from})으로 되돌렸습니다` : `이전 버전(${last.from})으로 되돌리지도 못했습니다. 서버에서 확인해야 합니다`;
  return [{ text: `${last.to} 업데이트에 실패해 ${back}: ${String(last.error).slice(0, 200)}`, ticket: null }];
}
