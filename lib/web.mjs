// `fieldtest web`: the local dashboard. Serves web/dist and a JSON API over the data directory, logs and
// GitHub, on 127.0.0.1 only. Commands go to the same queue as Slack buttons, so `fieldtest watch` stays
// the only process that runs them. Runs as the human user (systemd user unit fieldtest-web).
import { randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { INSTALL, MAX_APPROVAL_WAITING, TOOL_DIR, paths } from "./config.mjs";
import { repoSlug } from "./recipe.mjs";
import { setupApi } from "./setup-api.mjs";
import { readRecipeState } from "./bootstrap.mjs";
import { setupDone } from "./setup.mjs";
import { run } from "./exec.mjs";
import { requiredContexts } from "./github.mjs";
import { reviewState } from "./review.mjs";
import { hostStatus } from "./host.mjs";
import { listFindings, listSessions } from "./findings.mjs";
import { LANES } from "./lane.mjs";
import { shotRows } from "./shots.mjs";
import { COMMANDS_FILE, QUEUE_DIR, enqueue, route, threadOf, wakeWatch } from "./slack.mjs";
import { approvalWaiting, listTickets, readJson, readState, readTicket, ticketDir } from "./store.mjs";
import { describeBroken, readAfterMerge } from "./aftermerge.mjs";
import { alertsOf, cardOf, checksSummary, exploringOf, outcomeOf, parseLine } from "./view.mjs";

export const PORT = Number(process.env.FIELDTEST_WEB_PORT ?? INSTALL.webPort);
const DIST = join(TOOL_DIR, "web", "dist");
const LOG_BYTES = 2 * 1024 * 1024;
const STALE_MS = 5 * 60 * 1000;
const ID = /^QA-\d{4}$/;
const VERBS = ["승인", "거절", "수정", "머지"];
const IMAGES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const STATIC = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".ico": "image/x-icon", ...IMAGES };

// Tokens never reach the page, even if a tool printed one into a log.
export function redact(text) {
  return String(text ?? "").replace(/(xox[abpre]-[\w-]+|xapp-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w+|sk-[\w-]{16,}|ntn_\w{20,}|secret_\w{20,})/g, "[가림]");
}

// ---------- reading ----------

function tail(file, bytes = LOG_BYTES) {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // partial first line
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

const LOGS = ["loop", "watch", "slack"];

function logLines(source) {
  return tail(join(paths.run, `${source}.log`)).map((l) => ({ source, ...parseLine(l) }));
}

// Lines that name a ticket, by ticket, oldest first across loop and watch.
function linesByTicket(all) {
  const by = new Map();
  for (const l of all) {
    for (const id of new Set(l.text.match(/QA-\d{4}/g) ?? [])) {
      if (!by.has(id)) by.set(id, []);
      by.get(id).push(l);
    }
  }
  return by;
}

const byTime = (a, b) => (a.at ?? "").localeCompare(b.at ?? "");

const cache = new Map();
function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = Promise.resolve()
    .then(fn)
    .catch((e) => {
      cache.delete(key);
      throw e;
    });
  cache.set(key, { at: Date.now(), value });
  return value;
}

// A oneshot watch run is "activating" while it runs; the always-on services are "active".
async function serviceRunning(unit) {
  const r = await run("systemctl", ["--user", "show", "--property=ActiveState", "--value", unit]);
  return r.code === 0 && /^(active|activating)$/.test(r.stdout.trim());
}

function processes(logs) {
  return cached("processes", 15_000, async () => {
    const last = (source) => logs[source].findLast((l) => l.at)?.at ?? null;
    const [loop, slack, watching] = await Promise.all([
      serviceRunning("fieldtest.service"),
      serviceRunning("fieldtest-slack.service"),
      serviceRunning("fieldtest-watch.service"),
    ]);
    const ws = readJson(join(paths.run, "watch-state.json"), {});
    return [
      { name: "loop", lastAt: last("loop"), runningSince: null, stale: !loop },
      watchProcess(ws, watching),
      { name: "slack", lastAt: last("slack"), runningSince: null, stale: !slack },
    ];
  });
}

// A systemd timer starts watch every minute and never twice at once. A run in progress is live however long
// its merges take; between runs, a last run that ended more than STALE_MS ago means watch stopped.
export function watchProcess(ws, running, at = Date.now()) {
  const lastAt = ws.ranAt ?? null;
  if (running) return { name: "watch", lastAt, runningSince: ws.startedAt ?? null, stale: false };
  return { name: "watch", lastAt, runningSince: null, stale: !lastAt || at - Date.parse(lastAt) > STALE_MS };
}

// Open PRs: required check progress for every one (one call), review state for the ones in review.
function openPrs() {
  return cached("prs", 30_000, async () => {
    const r = await run("gh", ["pr", "list", "--repo", repoSlug(), "--state", "open", "--limit", "100", "--json", "number,headRefOid,statusCheckRollup"]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
    const required = await cached("required", 10 * 60_000, () => requiredContexts().catch(() => []));
    return new Map(JSON.parse(r.stdout).map((p) => [p.number, { head: p.headRefOid, ...checksSummary(p.statusCheckRollup ?? [], required) }]));
  });
}

// Read only: watch posts the review; the dashboard only shows whether it is there and answered.
function codexOf(t, head) {
  return cached(`codex:${t.pr.number}:${head}`, 60_000, async () => {
    const s = await reviewState(t, head);
    return s.done ? { codex: s.findings.length ? "findings" : "clean", findings: s.findings.length } : { codex: "pending", findings: 0 };
  });
}

async function prInfo(t, prs) {
  const p = t.pr && prs?.get(t.pr.number);
  if (!p) return null;
  const wantsCodex = t.status === "pr-review" || (t.status === "final-review" && t.autoMerge);
  const codex = wantsCodex ? await codexOf(t, p.head).catch(() => ({})) : {};
  return { ...p, ...codex };
}

function runFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// The directory of the run the loop is in now: a PR fix round, an exploration's session, or the
// newest work directory of the finding, screen or ticket.
function liveDir(cur, t) {
  if (cur.task === "PR 수정" && t?.pr) return join(ticketDir(t.id), "pr-rounds", String((t.pr.round ?? 0) + 1));
  if (cur.session) return join(paths.sessions, cur.session);
  const since = Date.parse(cur.since ?? 0) - 60_000;
  const names = runFiles(join(paths.runs, "work")).filter((n) => {
    const ts = Number(n.split("-")[0]);
    if (!(ts >= since)) return false;
    return cur.ticket ? n.includes(`-${cur.ticket}-`) || n.endsWith(`-${cur.ticket}`) : n.endsWith(`-${cur.finding ?? cur.screen}`);
  });
  const newest = names.sort().at(-1);
  return newest ? join(paths.runs, "work", newest) : null;
}

// What each lane is doing, refined by its last progress line and run files.
function livesOf(state, loopLogs, tickets) {
  return Object.values(LANES)
    .map((lane) => state.lanes?.[lane.name] && liveOf(state.lanes[lane.name], loopLogs, tickets))
    .filter(Boolean);
}

function liveOf(cur, loopLogs, tickets) {
  const t = cur.ticket ? tickets.find((x) => x.id === cur.ticket) : null;
  const prefixes = [cur.ticket, cur.screen, cur.session && "탐색"].filter(Boolean).map((p) => `${p}:`);
  const line = loopLogs.findLast((l) => l.at && l.at >= (cur.since ?? "") && prefixes.some((p) => l.text.startsWith(p)) && !l.text.includes('{"result"'));
  const dir = liveDir(cur, t);
  return {
    task: cur.task,
    ticket: cur.ticket ?? null,
    screen: cur.screen ?? null,
    title: cur.title ?? null,
    track: cur.track ?? null,
    since: line?.at ?? cur.since ?? null,
    startedAt: cur.since ?? null,
    line: line?.text ?? null,
    files: dir ? runFiles(dir) : [],
  };
}

// .json waits for the next watch run; .running is being run by watch now.
function queued() {
  return runFiles(QUEUE_DIR)
    .filter((f) => f.endsWith(".json") || f.endsWith(".running"))
    .map((f) => ({ f, q: readJson(join(QUEUE_DIR, f), null) }))
    .filter(({ q }) => q)
    .map(({ f, q }) => ({ at: new Date(q.at * 1000).toISOString(), id: q.id, verb: q.verb, arg: q.arg ?? "", source: q.source ?? "slack", ok: null, message: f.endsWith(".running") ? "watch 처리 중" : "watch 처리 대기" }));
}

export function readCommands(limit = 100) {
  const done = tail(COMMANDS_FILE, 512 * 1024)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((c) => ({ ...c, arg: redact(c.arg ?? ""), message: redact(c.message ?? "") }));
  return [...done, ...queued()].sort(byTime).reverse().slice(0, limit);
}

// Exploration-lane work that has no ticket yet (lib/agent.mjs exploreIteration).
const EXPLORE_TASKS = ["탐색", "판정", "결함 수정"];

// The board and an open ticket poll together; one build serves both.
const overview = () => cached("overview", 2_000, buildOverview);

async function buildOverview() {
  const tickets = listTickets();
  const state = readState();
  const logs = Object.fromEntries(LOGS.map((s) => [s, logLines(s)]));
  const byTicket = linesByTicket([...logs.loop, ...logs.watch].sort(byTime));
  const lives = livesOf(state, logs.loop, tickets);
  const exploring = lives.find((l) => !l.ticket && EXPLORE_TASKS.includes(l.task));
  const prs = await openPrs().catch(() => null);
  const waiting = queued();
  const cards = await Promise.all(
    tickets.map(async (t) =>
      cardOf(t, {
        lines: byTicket.get(t.id) ?? [],
        live: lives.find((l) => l.ticket === t.id) ?? null,
        pr: await prInfo(t, prs),
        queued: waiting.find((q) => q.id === t.id) ?? null,
      }),
    ),
  );
  for (const c of cards) if (c.blocked) c.blocked.text = redact(c.blocked.text);
  const procs = await processes(logs);
  return {
    now: new Date().toISOString(),
    loop: {
      lanes: Object.values(LANES).map((lane) => {
        const cur = state.lanes?.[lane.name];
        return { name: lane.name, label: lane.label, task: cur?.task ?? null, ticket: cur?.ticket ?? null, screen: cur?.screen ?? null, title: cur?.title ?? null, since: cur?.since ?? null };
      }),
      idle: state.idle ?? null,
      processes: procs,
    },
    approval: { count: approvalWaiting(tickets), limit: MAX_APPROVAL_WAITING },
    exploring: exploring ? exploringOf(exploring) : null,
    cards,
    alerts: alertsOf(cards, procs, Boolean(state.mainBroken), afterMergeAlert(), readRecipeState()),
    commands: readCommands(30),
  };
}

function afterMergeAlert() {
  const broken = readAfterMerge().broken;
  return broken ? describeBroken(broken) : null;
}

function lastGate(dir) {
  const gates = runFiles(dir)
    .filter((f) => /^gate-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const g = gates.length ? readJson(join(dir, gates.at(-1)), null) : null;
  return g?.steps?.map((s) => ({ name: s.name, ok: s.ok, detail: redact(s.detail ?? "") })) ?? null;
}

function shotsIn(id, rel) {
  const names = runFiles(join(ticketDir(id), rel, "shots"));
  return shotRows(names).map((r) => ({
    label: r.label,
    before: r.before ? `/api/files/${id}/${rel}/shots/${r.before}` : null,
    after: r.after ? `/api/files/${id}/${rel}/shots/${r.after}` : null,
  }));
}

const mtime = (p) => {
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
};

function attemptsOf(id) {
  const root = join(ticketDir(id), "attempts");
  const key = (n) => (n.startsWith("failed-") ? Number(n.split("-")[2]) : Date.parse(mtime(join(root, n)) ?? 0));
  return runFiles(root)
    .sort((a, b) => key(a) - key(b))
    .map((n) => {
      const dir = join(root, n);
      const review = readJson(join(dir, "review.json"), null);
      return {
        n,
        failed: n.startsWith("failed-"),
        at: mtime(dir),
        feedback: readJson(join(dir, "meta.json"), {})?.feedback ?? null,
        gate: lastGate(dir),
        review: review ? { verdict: review.verdict, findings: review.findings ?? [], notChecked: review.notChecked } : null,
        shots: shotsIn(id, `attempts/${n}`),
      };
    });
}

function roundsOf(id) {
  const root = join(ticketDir(id), "pr-rounds");
  return runFiles(root)
    .filter((n) => /^\d+$/.test(n))
    .sort((a, b) => a - b)
    .map((n) => {
      const dir = join(root, n);
      const r = readJson(join(dir, "result.json"), null);
      return { n: Number(n), at: mtime(dir), status: r?.status ?? null, summary: redact(r?.summary ?? "") || null, reason: redact(r?.reason ?? "") || null, gate: lastGate(dir) };
    });
}

async function detail(id) {
  const t = readTicket(id);
  if (!t) return null;
  const all = await overview();
  const card = all.cards.find((c) => c.id === id);
  const logs = LOGS.flatMap((s) => logLines(s))
    .filter((l) => l.text.includes(id))
    .sort(byTime)
    .slice(-300)
    .map((l) => ({ ...l, text: redact(l.text) }));
  const raw = readJson(join(ticketDir(id), "card.json"), null);
  const notes = [
    ["남은 문제", t.prNote],
    ["재구현 실패", t.reviseNote],
    ["판단이 필요한 이유", t.needsHumanReason],
    ["거절 이유", t.rejectReason],
  ]
    .filter(([, text]) => text)
    .map(([label, text]) => ({ label, text: redact(text) }));
  let ticketMd = "";
  try {
    ticketMd = readFileSync(join(ticketDir(id), "ticket.md"), "utf8");
  } catch {}
  return {
    card,
    summary: raw ? { summary: raw.summary, expected: raw.expected, actual: raw.actual, cause: raw.cause, fix: raw.fix ?? [] } : null,
    ticketMd: redact(ticketMd),
    notes,
    shots: t.attempt ? shotsIn(id, `attempts/${t.attempt}`) : [],
    attempts: attemptsOf(id),
    rounds: roundsOf(id),
    logs,
    commands: withOutcomes(readCommands(500).filter((c) => c.id === id), id),
  };
}

// Each command's result line, looked up before the next command for the ticket. Commands are newest first.
function withOutcomes(commands, id) {
  const lines = LOGS.flatMap((s) => logLines(s))
    .filter((l) => l.text.includes(id) && (l.text.includes('{"result"') || /: (merged|closed|auto-merge-stopped)$/.test(l.text)))
    .sort(byTime)
    .map((l) => ({ ...l, text: redact(l.text) }));
  return commands.map((c, i) => ({ ...c, outcome: outcomeOf(c, lines, i > 0 ? commands[i - 1].at : null) }));
}

async function prStatus(id) {
  const t = readTicket(id);
  const n = t?.pr?.number ?? t?.resolvedBy?.number;
  if (!n) return null;
  return cached(`pr:${n}`, 30_000, async () => {
    const r = await run("gh", ["pr", "view", String(n), "--repo", repoSlug(), "--json", "number,url,state,headRefOid,statusCheckRollup"]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
    const pr = JSON.parse(r.stdout);
    const required = await cached("required", 10 * 60_000, () => requiredContexts().catch(() => []));
    const sum = checksSummary(pr.statusCheckRollup ?? [], required);
    const codex = pr.state === "OPEN" ? await codexOf(n, pr.headRefOid).catch(() => ({ codex: "pending", findings: 0 })) : { codex: "clean", findings: 0 };
    return { number: pr.number, url: pr.url, state: pr.state, checks: sum.checks, passed: sum.passed, total: sum.total, ...codex };
  });
}

// The 탐색 tab: findings newest first and the latest explorations.
function exploreInfo() {
  const findings = listFindings()
    .reverse()
    .map((f) => ({ id: f.id, status: f.status, area: f.area, severity: f.severity, kind: f.kind, track: f.track && f.track !== "fix" ? "improve" : "fix", proposal: f.track === "propose", title: f.title, session: f.session, ticket: f.ticket ?? null, reason: redact(f.reason ?? "") || null, createdAt: f.createdAt, updatedAt: f.updatedAt }));
  const sessions = listSessions(30)
    .reverse()
    .map((x) => ({
      id: x.id,
      at: x.at ?? null,
      status: x.status ?? null,
      conditions: x.conditions ?? null,
      persona: x.persona ?? null,
      goal: x.goal ?? null,
      goalReached: x.goalReached ?? null,
      summary: x.summary ?? null,
      steps: x.steps ?? null,
      mismatched: x.mismatched ?? null,
      friction: x.friction ?? null,
      verdicts: x.verdicts ?? null,
      unjudged: x.unjudged ?? [],
      findings: x.findings ?? [],
      error: x.error ? redact(x.error) : null,
    }));
  return { findings, sessions };
}

// One exploration's steps, each with the judgment that covers it.
function sessionDetail(id) {
  const dir = join(paths.sessions, id);
  if (!existsSync(join(dir, "session.json"))) return null;
  const use = readJson(join(dir, "use.json"), null);
  const judgments = readJson(join(dir, "judge.json"), null)?.judgments ?? [];
  const shot = (sub, name) => (name && existsSync(join(dir, sub, name)) ? `/api/sessions/${id}/files/${sub}/${name}` : null);
  return {
    id,
    steps: (use?.steps ?? []).map((st) => {
      const j = judgments.find((x) => x.steps.includes(st.n));
      return {
        ...st,
        shot: shot("shots", st.screenshot),
        judgeShot: shot("judge-shots", `judge-${st.n}.png`),
        verdict: j?.verdict ?? null,
        reason: j?.reason ?? null,
        duplicateOf: j?.duplicateOf || null,
      };
    }),
  };
}

// ---------- commands ----------

export function queueCommand(id, body) {
  const verb = body?.verb;
  const arg = typeof body?.arg === "string" ? body.arg.trim() : "";
  if (!VERBS.includes(verb)) return { status: 400, body: { error: "알 수 없는 명령입니다" } };
  const t = readTicket(id);
  if (!t) return { status: 404, body: { error: "티켓이 없습니다" } };
  if (queued().some((q) => q.id === id)) return { status: 409, body: { error: "이 티켓의 이전 명령이 아직 처리 대기 중입니다" } };
  const plan = route(t, { id, verb, arg });
  if (plan.error) return { status: 409, body: { error: plan.error } };
  enqueue({ id, verb, arg, thread: threadOf(id), source: "web" });
  // The board refetches right after this; a cached build from before the command would hide it.
  cache.delete("overview");
  return { status: 202, body: { queued: true } };
}

// ---------- http ----------

function send(res, status, body, headers = {}) {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(json);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        fail(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

function sendFile(res, file, type) {
  res.writeHead(200, { "content-type": type, "cache-control": file.startsWith(DIST) && !file.endsWith(".html") ? "public, max-age=3600" : "no-store" });
  createReadStream(file).pipe(res);
}

function inside(root, rel) {
  const full = resolve(root, rel);
  return full.startsWith(root + sep) ? full : null;
}

function serveStatic(res, pathname) {
  if (!existsSync(join(DIST, "index.html"))) return send(res, 503, "web/dist가 없습니다. web에서 npm run build를 실행하세요.");
  const file = pathname !== "/" && inside(DIST, `.${decodeURIComponent(pathname)}`);
  if (file && existsSync(file) && statSync(file).isFile()) return sendFile(res, file, STATIC[extname(file)] ?? "application/octet-stream");
  return sendFile(res, join(DIST, "index.html"), STATIC[".html"]);
}

// DNS rebinding: a page on another name that resolves to 127.0.0.1 sends its own Host. The port is
// whatever the tunnel picked on the installer's computer (several installs open at once).
export const allowedHost = (host) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);

export function handler({ token = randomBytes(24).toString("hex"), wake = wakeWatch } = {}) {
  return async (req, res) => {
    if (!allowedHost(req.headers.host ?? "")) return send(res, 421, "잘못된 Host");
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    try {
      if (req.method === "POST") {
        // Another site in the browser can send a POST here but cannot read /api/session for the token.
        if (req.headers["x-fieldtest-token"] !== token) return send(res, 403, { error: "토큰이 맞지 않습니다" });
        if (p.startsWith("/api/setup/")) {
          const raw = await readBody(req);
          let body = {};
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            return send(res, 400, { error: "JSON 본문이 필요합니다" });
          }
          const out = await setupApi("POST", p, body);
          return send(res, out.status, out.body);
        }
        if (!setupDone()) return send(res, 409, { setup: true });
        const m = p.match(/^\/api\/tickets\/(QA-\d{4})\/commands$/);
        if (!m) return send(res, 404, { error: "없는 경로" });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: "JSON 본문이 필요합니다" });
        }
        const out = queueCommand(m[1], body);
        if (out.status === 202) await wake().catch(() => {});
        return send(res, out.status, out.body);
      }
      if (req.method !== "GET") return send(res, 405, { error: "허용되지 않는 메서드" });
      if (p === "/api/session") return send(res, 200, { token });
      if (p.startsWith("/api/setup/")) {
        const out = await setupApi("GET", p);
        return out.file ? sendFile(res, out.file, out.type) : send(res, out.status, out.body);
      }
      // Until the wizard finishes there is no recipe or loop to show.
      if (p.startsWith("/api/") && !setupDone()) return send(res, 409, { setup: true });
      if (p === "/api/overview") return send(res, 200, await overview());
      if (p === "/api/explore") return send(res, 200, exploreInfo());
      if (p === "/api/server") return send(res, 200, await cached("server", 3000, () => hostStatus(redact)));
      if (p === "/api/commands") return send(res, 200, readCommands(Number(url.searchParams.get("limit")) || 100));
      if (p === "/api/logs") {
        const source = LOGS.includes(url.searchParams.get("source")) ? url.searchParams.get("source") : "loop";
        const ticket = url.searchParams.get("ticket")?.toUpperCase();
        const limit = Math.min(Number(url.searchParams.get("limit")) || 300, 2000);
        const lines = logLines(source).filter((l) => !ticket || l.text.includes(ticket));
        return send(res, 200, lines.slice(-limit).map((l) => ({ ...l, text: redact(l.text) })));
      }
      let m = p.match(/^\/api\/tickets\/(QA-\d{4})(\/pr)?$/);
      if (m) {
        const out = m[2] ? await prStatus(m[1]) : await detail(m[1]);
        return out ? send(res, 200, out) : send(res, 404, { error: m[2] ? "PR이 없습니다" : "티켓이 없습니다" });
      }
      m = p.match(/^\/api\/sessions\/(\d+)(?:\/files\/((?:shots|judge-shots)\/[^/]+))?$/);
      if (m && !m[2]) {
        const out = sessionDetail(m[1]);
        return out ? send(res, 200, out) : send(res, 404, { error: "탐색 기록이 없습니다" });
      }
      if (m) {
        const file = inside(join(paths.sessions, m[1]), decodeURIComponent(m[2]));
        const type = file && IMAGES[extname(file).toLowerCase()];
        if (!file || !type || !existsSync(file)) return send(res, 404, { error: "파일이 없습니다" });
        return sendFile(res, file, type);
      }
      m = p.match(/^\/api\/files\/(QA-\d{4})\/(.+)$/);
      if (m) {
        const file = ID.test(m[1]) && inside(ticketDir(m[1]), decodeURIComponent(m[2]));
        const type = file && IMAGES[extname(file).toLowerCase()];
        if (!file || !type || !existsSync(file)) return send(res, 404, { error: "파일이 없습니다" });
        return sendFile(res, file, type);
      }
      if (p.startsWith("/api/")) return send(res, 404, { error: "없는 경로" });
      return serveStatic(res, p);
    } catch (e) {
      return send(res, 500, { error: redact(e.message) });
    }
  };
}

export function serve(port = PORT) {
  const server = createServer(handler());
  server.listen(port, "127.0.0.1", () => console.log(`[${new Date().toISOString()}] http://127.0.0.1:${port}`));
  return server;
}
