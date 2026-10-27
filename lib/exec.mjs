import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./config.mjs";
import { laneEnv } from "./lane.mjs";
import { recipeEnv } from "./recipe.mjs";

const KEEP = 4 * 1024 * 1024;

// Process groups started by run() that are still alive. When the loop exits (systemd stop, restart)
// they are killed with it; the registry file lets the next loop start kill what a hard crash left.
const active = new Set();
let registry = null;

function saveRegistry() {
  if (registry) writeFileSync(registry, JSON.stringify([...active]));
}

export function trackChildren(file) {
  registry = file;
  let leftover = [];
  try {
    leftover = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  for (const pid of leftover) killGroup(pid, "SIGKILL");
  saveRegistry();
  return leftover.length;
}

// SIGTERM, not SIGKILL: a Claude session then stops the shells it started in their own groups.
process.on("exit", () => {
  for (const pid of active) killGroup(pid, "SIGTERM");
  active.clear();
  saveRegistry();
});

function tail(chunks) {
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > KEEP ? text.slice(-KEEP) : text;
}

// Runs one command without a shell. The child gets its own process group so a timeout
// can stop everything it started (dev servers, browsers) and nothing else.
// Git commands on the shared repository (fetch, worktree add/remove, branches) run one at a time:
// the two lanes would otherwise race on its lock files. Commands inside a worktree run freely.
let repoQueue = Promise.resolve();

export function run(cmd, args, opts = {}) {
  if (cmd !== "git" || opts.cwd !== paths.repo) return spawnRun(cmd, args, opts);
  const next = repoQueue.then(() => spawnRun(cmd, args, opts));
  repoQueue = next.catch(() => {});
  return next;
}

function spawnRun(cmd, args, { cwd, env, input, timeoutMs = 0, logFile, onStdout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...(env ?? process.env), ...laneEnv(), ...recipeEnv() },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    let timedOut = false;
    if (child.pid) {
      active.add(child.pid);
      saveRegistry();
    }
    const log = (prefix, data) => {
      if (logFile) appendFileSync(logFile, prefix ? data.toString().replace(/^/gm, prefix) : data);
    };
    if (logFile) appendFileSync(logFile, `\n$ ${cmd} ${args.join(" ")}\n`);
    child.stdout.on("data", (d) => {
      out.push(d);
      log("", d);
      onStdout?.(d);
    });
    child.stderr.on("data", (d) => {
      err.push(d);
      log("", d);
    });
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, "SIGTERM");
        setTimeout(() => killGroup(child.pid, "SIGKILL"), 10_000).unref();
      }, timeoutMs);
    }
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Leftover grandchildren (a dev server the session forgot) belong to this group.
      killGroup(child.pid, "SIGTERM");
      active.delete(child.pid);
      saveRegistry();
      resolve({ code: code ?? -1, stdout: tail(out), stderr: tail(err), timedOut });
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Session processes this user left behind, found by command and killed by PID. The agent user runs
// nothing but the loop, so at loop start any of these are orphans of an earlier run.
const SESSION_COMMAND = /(^|\/)(claude -p|codex exec|npm exec @playwright\/mcp|playwright-mcp|next dev|next-server)|playwright test/;

export function sweepOrphans() {
  const self = new Set([process.pid, process.ppid]);
  const r = spawnSyncSafe("ps", ["-o", "pid=,command=", "-U", String(process.getuid())]);
  let killed = 0;
  for (const line of r.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || self.has(Number(m[1])) || !SESSION_COMMAND.test(m[2])) continue;
    try {
      process.kill(Number(m[1]), "SIGKILL");
      killed++;
    } catch {}
  }
  return killed;
}

function spawnSyncSafe(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch {
    return "";
  }
}

export function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

// Throws with the command's output when it fails. For steps where failure means a bug or
// a broken environment, not a result to record.
export async function must(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const msg = `${cmd} ${args.join(" ")} failed (${r.code})${r.timedOut ? " after timeout" : ""}\n${r.stderr || r.stdout}`.slice(0, 4000);
    throw new Error(msg);
  }
  return r;
}

export function git(cwd, args, opts = {}) {
  return must("git", args, { cwd, ...opts });
}

export async function gitOut(cwd, args) {
  return (await git(cwd, args)).stdout.trim();
}
