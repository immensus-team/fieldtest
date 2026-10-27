// Host status for the dashboard's 서버 view: CPU, memory, disk, systemd units and the busiest processes
// of the EC2 host (Linux). `fieldtest web` runs on the host itself, so everything comes from /proc,
// statfs, systemctl and the instance metadata service; no AWS API permission is needed.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, statfsSync } from "node:fs";
import { arch, cpus, hostname, loadavg, release, uptime } from "node:os";
import { checkTimes } from "./check-times.mjs";
import { DATA_DIR, INSTALL } from "./config.mjs";
import { run } from "./exec.mjs";

export const UNITS = [
  { unit: "fieldtest.service", label: "루프" },
  { unit: "fieldtest-watch.timer", label: "watch 타이머" },
  { unit: "fieldtest-slack.service", label: "Slack" },
  { unit: "fieldtest-web.service", label: "대시보드" },
];
const SAMPLE_MS = 400;
const TOP = 12;

// `cpu  user nice system idle iowait irq softirq steal ...` (USER_HZ ticks since boot).
export function parseCpuLine(text) {
  const v = text.split("\n")[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return { idle: v[3] + v[4], total: v.reduce((a, b) => a + b, 0) };
}

export function cpuPercent(a, b) {
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 1000) / 10 : 0;
}

export function parseMeminfo(text) {
  const kb = (name) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"))?.[1] ?? 0) * 1024;
  return { total: kb("MemTotal"), available: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
}

// /proc/<pid>/stat: the command name sits in parentheses and may itself contain spaces or ")".
export function parseProcStat(text) {
  const close = text.lastIndexOf(")");
  const rest = text.slice(close + 2).split(" ");
  return { ticks: Number(rest[11]) + Number(rest[12]), start: Number(rest[19]), rssPages: Number(rest[21]) };
}

// `systemctl show` prints one block of KEY=value lines per unit, separated by a blank line.
export function parseShow(text) {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])));
}

const KINDS = [
  { kind: "browser", label: "브라우저", test: /chrom(e|ium)|headless_shell/ },
  { kind: "next", label: "Next", test: /next-server|next-build|next(\.js)? (dev|build|start)|\/next\/dist\/|turbopack/ },
  { kind: "claude", label: "Claude", test: /(^|\/)claude( |$)/ },
  { kind: "codex", label: "Codex", test: /(^|\/)codex( |$)|@openai\/codex/ },
  { kind: "check", label: "검사·빌드", test: /--test|vitest|playwright|tsc |biome|(^|\/)turbo |pnpm (run )?(lint|typecheck|test|build)/ },
  { kind: "fieldtest", label: "fieldtest 서비스", test: /fieldtest\.mjs/ },
];

export function classify(command) {
  return KINDS.find((k) => k.test.test(command)) ?? { kind: "other", label: "기타" };
}

let clkTck = null;
let pageSize = null;
function sysconf() {
  if (clkTck) return;
  try {
    clkTck = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
    pageSize = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim()) || 4096;
  } catch {
    clkTck = 100;
    pageSize = 4096;
  }
}

const userNames = new Map();
function userName(uid) {
  if (!userNames.has(uid)) {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.split(":")[2] === String(uid));
    userNames.set(uid, line?.split(":")[0] ?? String(uid));
  }
  return userNames.get(uid);
}

function processTicks() {
  const out = new Map();
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      out.set(pid, { ...parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8")), uid: statSync(`/proc/${pid}`).uid });
    } catch {}
  }
  return out;
}

function commandOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

// CPU over the sample window, per process and for the whole host. `ps %cpu` averages a process's
// whole life, so it would show a finished build as busy for minutes.
async function sample() {
  sysconf();
  const cpu0 = parseCpuLine(readFileSync("/proc/stat", "utf8"));
  const p0 = processTicks();
  const t0 = performance.now();
  await new Promise((ok) => setTimeout(ok, SAMPLE_MS));
  const cpu1 = parseCpuLine(readFileSync("/proc/stat", "utf8"));
  const p1 = processTicks();
  const seconds = (performance.now() - t0) / 1000;
  const bootAt = Date.now() / 1000 - uptime();
  const procs = [];
  for (const [pid, b] of p1) {
    const a = p0.get(pid);
    const user = userName(b.uid);
    if (user !== INSTALL.agent && user !== INSTALL.human) continue;
    const command = commandOf(pid);
    if (!command) continue;
    procs.push({
      pid: Number(pid),
      user,
      // A pid missing from the first read started inside the window, so all of its ticks belong to it.
      cpu: Math.round(((b.ticks - (a?.ticks ?? 0)) / clkTck / seconds) * 1000) / 10,
      rssBytes: b.rssPages * pageSize,
      startedAt: new Date((bootAt + b.start / clkTck) * 1000).toISOString(),
      command,
      ...classify(command),
    });
  }
  return { cpu: cpuPercent(cpu0, cpu1), procs };
}

let instance;
// IMDSv2. Cached once it answers; null where there is no metadata service (tests, a laptop).
async function instanceInfo() {
  if (instance) return instance;
  try {
    const base = "http://169.254.169.254/latest";
    const signal = () => AbortSignal.timeout(500);
    const token = await (
      await fetch(`${base}/api/token`, { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "300" }, signal: signal() })
    ).text();
    const get = async (path) => (await fetch(`${base}/meta-data/${path}`, { headers: { "X-aws-ec2-metadata-token": token }, signal: signal() })).text();
    const [id, type, az] = await Promise.all([get("instance-id"), get("instance-type"), get("placement/availability-zone")]);
    instance = { id, type, az, region: az.slice(0, -1) };
    return instance;
  } catch {
    return null;
  }
}

// --timestamp=unix prints "@1792779144"; a unit that never started prints nothing.
export function sinceOf(value) {
  const seconds = Number(value?.match(/^@(\d+)$/)?.[1]);
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

async function services() {
  const r = await run("systemctl", [
    "--user",
    "show",
    "--timestamp=unix",
    "--property=Id,ActiveState,SubState,ActiveEnterTimestamp,NRestarts,MemoryCurrent,MainPID,Result",
    ...UNITS.map((u) => u.unit),
  ]);
  if (r.code !== 0) return [];
  const byId = new Map(parseShow(r.stdout).map((s) => [s.Id, s]));
  return UNITS.map(({ unit, label }) => {
    const s = byId.get(unit) ?? {};
    const memory = Number(s.MemoryCurrent);
    return {
      unit,
      label,
      active: s.ActiveState ?? "unknown",
      sub: s.SubState ?? "",
      since: sinceOf(s.ActiveEnterTimestamp),
      restarts: Number(s.NRestarts ?? 0),
      memoryBytes: Number.isFinite(memory) && memory < 2 ** 62 ? memory : null,
      pid: Number(s.MainPID) || null,
      result: s.Result ?? "",
    };
  });
}

function osName() {
  try {
    return readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? "Linux";
  } catch {
    return "Linux";
  }
}

export async function hostStatus(redact) {
  const [{ cpu, procs }, inst, units] = await Promise.all([sample(), instanceInfo(), services()]);
  const mem = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  const fs = statfsSync(DATA_DIR);
  const groups = new Map();
  for (const p of procs) {
    const g = groups.get(p.kind) ?? { kind: p.kind, label: p.label, count: 0, cpu: 0, rssBytes: 0 };
    g.count++;
    g.cpu = Math.round((g.cpu + p.cpu) * 10) / 10;
    g.rssBytes += p.rssBytes;
    groups.set(p.kind, g);
  }
  return {
    at: new Date().toISOString(),
    host: { name: hostname(), os: osName(), kernel: release(), arch: arch(), uptimeSec: Math.round(uptime()), instance: inst },
    cpu: { percent: cpu, cores: cpus().length, load: loadavg().map((l) => Math.round(l * 100) / 100) },
    memory: { totalBytes: mem.total, availableBytes: mem.available, swapTotalBytes: mem.swapTotal, swapUsedBytes: mem.swapTotal - mem.swapFree },
    disk: { path: DATA_DIR, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize },
    services: units,
    checks: checkTimes(),
    groups: [...groups.values()].sort((a, b) => b.cpu - a.cpu || b.rssBytes - a.rssBytes),
    top: procs
      .sort((a, b) => b.cpu - a.cpu || b.rssBytes - a.rssBytes)
      .slice(0, TOP)
      .map(({ command, ...p }) => ({ ...p, command: redact(command).slice(0, 200) })),
  };
}
