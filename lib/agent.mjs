// The agent loop. Runs as the agent account (install.json), which has no GitHub write access.
// It uses the app freely, judges what went wrong, fixes the findings, verifies them, writes tickets and
// handles PR fix rounds.
// Everything it hands to the human side goes through files in the data directory.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BACKOFF_MS,
  GROUP_LIMITS,
  IDLE_WAIT_MS,
  MAX_CHANGED_FILES,
  MAX_CHANGED_LINES,
  MAX_APPROVAL_WAITING,
  MAX_FIX_TRIES,
  PROPOSAL_LIMITS,
  PROPOSALS_PER_DAY,
  REPRO_PASSES,
  TIMEOUTS,
  TOOL_DIR,
  paths,
  settings,
} from "./config.mjs";
import { makeCard, needsCard } from "./card.mjs";
import { demoUrl, loginInit, startDemo, stopDemo } from "./demo.mjs";
import { bootstrap, readRecipeState, requestRepair } from "./bootstrap.mjs";
import { exploreBlocked, recipeHash, setupScope, setupTicketNeeded } from "./repair.mjs";
import { loadSchema, renderPrompt, runClaude, runCodex } from "./engines.mjs";
import { git, gitOut, run, sweepOrphans, trackChildren } from "./exec.mjs";
import { gateSummary, hasShots, install, repoCheck, reviewLines, runGate, tailOf } from "./gate.mjs";
import { LANES, currentLane, inLane } from "./lane.mjs";
import { addWorktree, cleanWorktrees, fetchOrigin, removeWorktree } from "./worktree.mjs";
import { createFinding, listFindings, listSessions, nextOpenFinding, readFinding, recentGoals, reopenFixing, updateFinding } from "./findings.mjs";
import { acquireLock } from "./lock.mjs";
import { applyGroupPlan, classifyCause, groupPlan, needsCause, ticketScreen } from "./group.mjs";
import { currentRecipe, originBase } from "./recipe.mjs";
import { pendingReviews, reviewFailed, reviewFindings, writeReviewResult } from "./review.mjs";
import { loadScreens } from "./screens.mjs";
import {
  createTicket,
  listTickets,
  logRun,
  nextTicketId,
  overApprovalCap,
  readJson,
  readState,
  ticketDir,
  transition,
  writeJson,
  writeState,
} from "./store.mjs";

export class EngineError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const say = (msg) => console.log(`[${now()}] ${msg}`);

// ---------- git helpers ----------

// Squashes everything since `base` into one commit. Returns the new HEAD or null when nothing changed.
async function commitSquashed(wt, base, message) {
  await git(wt, ["add", "-A"]);
  await git(wt, ["reset", "--soft", base]);
  const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: wt });
  if (staged.code === 0) return null;
  await git(wt, ["commit", "--quiet", "--no-verify", "-m", message]);
  return gitOut(wt, ["rev-parse", "HEAD"]);
}

async function bundle(file, branch, sha, exclude) {
  const current = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: paths.repo });
  if (current.stdout.trim() !== sha) await git(paths.repo, ["branch", "-f", branch, sha]);
  await git(paths.repo, ["bundle", "create", file, branch, `^${exclude}`]);
}

// A proof spec showed the fix in the gate and to the reviewer; it does not join the suite.
async function dropProof(wt, base, gate, message) {
  await git(wt, ["rm", "--quiet", "--", ...gate.proof]);
  gate.files = gate.files.filter((f) => !gate.proof.includes(f));
  return commitSquashed(wt, base, message);
}

// The reviewer must not change the candidate. Anything it left behind is thrown away.
async function restoreCandidate(wt, sha) {
  const head = await gitOut(wt, ["rev-parse", "HEAD"]);
  const dirty = (await gitOut(wt, ["status", "--porcelain"])) !== "";
  if (head !== sha || dirty) {
    await git(wt, ["reset", "--hard", "--quiet", sha]);
    await git(wt, ["clean", "-fdq"]);
    return false;
  }
  return true;
}

// ---------- prompt pieces ----------

function ticketFiles(t) {
  return readJson(join(ticketDir(t.id), "attempts", String(t.attempt), "files.json"), []);
}

function ticketLine(t, { withScreen = false } = {}) {
  const files = ticketFiles(t);
  const extra = [
    t.cause ? `원인: \`${t.cause.key}\`` : "",
    files.length ? `고친 파일: ${files.join(", ")}` : "",
    t.needsHumanReason ? `판단 필요 사유: ${t.needsHumanReason}` : "",
    t.rejectReason ? `거절 사유: ${t.rejectReason}` : "",
  ].filter(Boolean);
  return `- ${t.id} [${withScreen ? `${t.screen}, ` : ""}${t.status}] ${t.title}${extra.length ? `\n  ${extra.join("\n  ")}` : ""}`;
}

// Tickets already filed, so the session doesn't report them again: every ticket of this screen, and
// the open or rejected ones of other screens (all screens may change the same components). A revise
// leaves out the ticket it is redoing (a group, also the tickets it took over); otherwise they read
// as duplicates of themselves. Causes a group is already fixing are not reported at all.
function screenTickets(screenId, excludeTicket) {
  const excluded = [excludeTicket].flat().filter(Boolean);
  const all = listTickets().filter((t) => !excluded.includes(t.id));
  const singles = all.filter((t) => !t.group);
  const mine = singles.filter((t) => t.screen === screenId);
  const others = singles.filter((t) => t.screen !== screenId && !["merged", "closed"].includes(t.status));
  const groups = all.filter((t) => t.group && !["merged", "rejected", "closed"].includes(t.status));
  if (!mine.length && !others.length && !groups.length) return "없음";
  const sections = [
    `### 이 화면\n\n${mine.map((t) => ticketLine(t)).join("\n") || "없음"}`,
    `### 다른 화면 (열려 있거나 거절된 것)\n\n${others.map((t) => ticketLine(t, { withScreen: true })).join("\n") || "없음"}`,
  ];
  if (groups.length) {
    sections.push(
      `### 묶음으로 고치는 중인 원인\n\n아래 원인으로 생기는 결함은 화면이 달라도 보고하지 않는다. 묶음 작업이 같은 원인의 다른 곳도 찾아 고친다.\n\n${groups
        .map((g) => `- \`${g.group.cause.key}\` (${g.id}): ${g.group.cause.summary}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function shotsOnly(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^(before|after)-.+\.png$/.test(f));
}

// mission: the finding to fix; a revise or group puts its problem in feedback instead.
export function implementVars(screen, { shotsDir, mission, feedback, excludeTicket, limits = { files: MAX_CHANGED_FILES, lines: MAX_CHANGED_LINES } }) {
  return {
    screenId: screen.id,
    url: `${demoUrl()}${screen.url}`,
    demoUrl: demoUrl(),
    area: screen.mission,
    mission: mission ?? '아래 "이번 작업" 절의 문제다.',
    specs: screen.specs.join(", ") || "없음",
    allowed: screen.paths.join(", "),
    forbidden: (screen.forbidden ?? currentRecipe().paths.forbidden).join(", "),
    existingTickets: screenTickets(screen.id, excludeTicket),
    feedback: feedback ?? "",
    reproPasses: REPRO_PASSES,
    shotsDir,
    toolDir: TOOL_DIR,
    maxFiles: limits.files,
    maxLines: limits.lines,
    ticketStyle: readFileSync(join(paths.prompts, "ticket-style.md"), "utf8"),
    SCREENSHOTS: "{{SCREENSHOTS}}",
  };
}

// Sections of a ticket that describe the problem but not the earlier fix. Used for revise,
// which must not see the previous approach.
export function problemOnly(ticketMd) {
  const keep = ["재현 절차", "기대 동작과 실제 동작", "사람 판단이 필요한 이유"];
  const parts = ticketMd.split(/^## /m);
  const title = parts[0].trim();
  const kept = parts.slice(1).filter((p) => keep.some((k) => p.startsWith(k)));
  return [title, ...kept.map((p) => `## ${p.trim()}`)].join("\n\n");
}

async function runImplementer(engine, opts) {
  if (engine === "codex") {
    return runCodex({ ...opts, schemaName: opts.schemaName });
  }
  return runClaude({ ...opts, schema: loadSchema(opts.schemaName) });
}

// ---------- candidate building (explore and revise share this) ----------

// Implement → gate → review, up to MAX_FIX_TRIES sessions in the same worktree.
// Returns { found:false } | { needsHuman, result, sha? } | { blocked:true, reason } | { ok:true, sha, result, gate, review }.
// needs-human (from the session or an oversized change) is never retried.
async function buildCandidate({ screen, base, wt, workDir, engine, model, mission, firstFeedback, mustFind, excludeTicket, limits, timeoutMs = TIMEOUTS.implement }) {
  const shotsDir = join(workDir, "shots");
  const reviewShots = join(workDir, "review-shots");
  const logFile = join(workDir, "run.log");
  const initPage = await loginInit(wt, workDir);
  let feedback = firstFeedback;
  let baseWt = null;
  let lastReason = "";
  // The reviewer's findings that blocked the last session, with its suggested fix.
  let lastFindings = [];
  try {
    for (let attempt = 1; attempt <= MAX_FIX_TRIES; attempt++) {
      say(`${screen.id}: 구현 세션 ${attempt}/${MAX_FIX_TRIES}`);
      const prompt = renderPrompt("implement", implementVars(screen, { shotsDir, mission, feedback, excludeTicket, limits }));
      const r = await runImplementer(engine, {
        cwd: wt,
        prompt,
        schemaName: "implement",
        model,
        shotsDir,
        logFile,
        timeoutMs,
        initPage,
      });
      stopDemo();
      if (!r.ok) throw new EngineError(r.error);
      const res = r.json;
      writeJson(join(workDir, `implement-${attempt}.json`), { ...res, usage: r.usage });
      if (res.status === "needs-human") return { needsHuman: res.reason || "구현자가 사람 판단이 필요하다고 했다.", result: res };
      // Trivial findings are noted, not fixed. high, medium and low become tickets. A revise must end
      // in a fix (the human already judged the defect) or in needs-human.
      const reportable = res.status === "fixed" && (mustFind || res.severity !== "trivial");
      if (!reportable) {
        if (!mustFind) return { found: false, notes: res.notes };
        lastReason = '수정 요청 작업이다. status="fixed"로 끝내고, 고칠 수 없으면 needs-human으로 끝낸다.';
        lastFindings = [];
        feedback = withRetry(firstFeedback, lastReason);
        continue;
      }

      const sha = await commitSquashed(wt, base, res.prTitle || "fix: qa candidate");
      if (!sha) {
        lastReason = "결함을 보고했지만 바뀐 파일이 없음.";
        lastFindings = [];
        feedback = withRetry(firstFeedback, lastReason);
        continue;
      }
      if (!baseWt && res.kind === "functional") {
        baseWt = await addWorktree(`${screen.id}-base`, base);
        const inst = await install(baseWt, logFile);
        if (inst.code !== 0) throw new Error(`base worktree 설치 실패\n${tailOf(inst)}`);
      }
      const gate = await runGate({
        wt,
        base,
        baseWt,
        screen,
        kind: res.kind,
        explainedTests: res.changedTestsReason,
        newSpecReason: res.newSpecReason,
        logFile,
        limits,
      });
      if (gate.ok && res.kind === "visual") {
        const shots = hasShots(shotsDir);
        const ok = shots.before > 0 && shots.after > 0;
        gate.steps.push({ name: "전후 스크린샷", ok, detail: ok ? "" : "시각 결함인데 before-/after- 스크린샷이 없다" });
        gate.ok = ok;
      }
      writeJson(join(workDir, `gate-${attempt}.json`), gate);
      if (gate.needsHuman) return { needsHuman: gate.needsHuman, result: res, sha, gate };
      if (!gate.ok) {
        lastReason = `실행기 검사 실패\n${gateSummary(gate)}`;
        lastFindings = [];
        feedback = withRetry(firstFeedback, lastReason);
        continue;
      }

      const diffFile = join(workDir, "diff.patch");
      writeFileSync(diffFile, (await git(wt, ["diff", "-M", base, sha])).stdout);
      say(`${screen.id}: 검토 세션`);
      const rv = await runCodex({
        cwd: wt,
        prompt: renderPrompt("review", {
          toolDir: TOOL_DIR,
          demoUrl: demoUrl(),
          shotsDir,
          ticket: res.ticket,
          gate: `${gateSummary(gate)}${gate.notes.length ? `\n\n참고:\n${gate.notes.join("\n")}` : ""}`,
          changedTestsReason: res.changedTestsReason || "없음",
          diffFile,
        }),
        schemaName: "review",
        model: settings().reviewModel,
        shotsDir: reviewShots,
        logFile,
        timeoutMs: TIMEOUTS.review,
        initPage,
      });
      stopDemo();
      const untouched = await restoreCandidate(wt, sha);
      if (!rv.ok) throw new EngineError(rv.error);
      writeJson(join(workDir, `review-${attempt}.json`), rv.json);
      const blocking = rv.json.findings.filter((f) => f.severity === "blocking");
      if (untouched && rv.json.verdict === "pass" && blocking.length === 0) {
        const kept = gate.proof.length ? await dropProof(wt, base, gate, res.prTitle || "fix: qa candidate") : sha;
        return { ok: true, sha: kept, result: res, gate, review: rv.json };
      }
      const shown = blocking.length ? blocking : rv.json.findings;
      lastFindings = untouched ? shown : [];
      lastReason = untouched
        ? `검토자가 후보를 통과시키지 않음\n${shown.map((f) => `- ${f.title}\n  조건: ${f.condition}\n  기대: ${f.expected}\n  실제: ${f.actual}\n  근거: ${f.evidence}`).join("\n")}`
        : "검토자가 후보 파일을 바꿈. 검토를 무효로 하고 다시 시도함.";
      feedback = withRetry(firstFeedback, lastReason);
    }
    return { blocked: true, reason: lastReason, advice: adviceOf(lastFindings) };
  } finally {
    await removeWorktree(baseWt);
  }
}

// The reviewer's suggested fixes, as a direction the human can send back with 수정 as is.
export function adviceOf(findings) {
  const fixes = findings.filter((f) => f.fix?.trim());
  if (!fixes.length) return null;
  if (fixes.length === 1) return fixes[0].fix.trim();
  return fixes.map((f) => `- ${f.title}: ${f.fix.trim()}`).join("\n");
}

// A failed revise keeps its work for diagnosis next to the attempts, instead of being deleted.
function keepFailed(tdir, workDir, n) {
  mkdirSync(join(tdir, "attempts"), { recursive: true });
  renameSync(workDir, join(tdir, "attempts", `failed-${n}-${Date.now()}`));
}

function withRetry(first, reason) {
  return [first, retryNote(reason)].filter(Boolean).join("\n\n");
}

function retryNote(reason) {
  return `## 이전 시도의 실패\n\n이 worktree에는 이전 시도의 변경이 남아 있다. 아래 문제를 해결한다. 같은 결함을 계속 고친다.\n\n${reason}`;
}

function writeTicketFiles(dir, built, extra = {}) {
  mkdirSync(dir, { recursive: true });
  const shots = shotsOnly(join(dir, "shots"));
  const ticketMd = `${built.result.ticket
    .replace(/## 스크린샷[\s\S]*?(?=\n## |$)/, `## 스크린샷\n${shots.map((s) => `- ${s}`).join("\n") || "- 없음"}\n`)
    .trimEnd()}\n\n## 실행기 검증\n\n${gateSummary(built.gate)}\n\n## 로컬 검토 (Codex)\n\n${reviewLines(built.review)}\n`;
  writeFileSync(join(dir, "ticket.md"), ticketMd);
  writeFileSync(join(dir, "pr-body.md"), built.result.prBody);
  writeJson(join(dir, "review.json"), built.review);
  writeJson(join(dir, "files.json"), built.gate.files);
  writeJson(join(dir, "meta.json"), { ...extra, notes: built.result.notes });
  return ticketMd;
}

// ---------- free exploration (design §4) ----------

// Explorations look for problems that stop work, not keyboard, width or theme nits (user, 2026-10-26),
// so they run at desktop width with both input kinds and rotate only the theme and the journey.
const THEMES = ["light", "dark"];

// The recipe's journeys (explore.journeys). Each exploration works inside one.
export const journeys = () => currentRecipe().explore.journeys;

// The n-th exploration's theme and journey, so sessions don't all use the same ones.
export function conditionsFor(n, list = journeys()) {
  return { width: 1440, theme: THEMES[Math.floor(n / list.length) % 2], input: "마우스와 키보드", journey: list[n % list.length] };
}

const conditionsText = (c) => `- 화면 폭: ${c.width}px\n- 테마: ${c.theme}\n- 입력 방식: ${c.input}\n- 업무 여정: ${c.journey}`;

export function areasText(screens = loadScreens()) {
  return screens.map((s) => `### ${s.id}\n\n시작 주소: \`${s.url}\`\n\n${s.mission}`).join("\n\n");
}

export function stepsText(steps) {
  return steps
    .map((s) => {
      const tags = [s.matched ? "기대대로" : "기대와 다름", s.friction ? "마찰" : "", s.probe ? "찔러 보기" : ""].filter(Boolean).join(", ");
      const friction = s.friction ? `\n   - 마찰: ${s.friction}` : "";
      const shot = s.screenshot ? `\n   - 스크린샷: ${s.screenshot}` : "";
      return `${s.n}. [${tags}] ${s.area} ${s.url}\n   - 행동: ${s.action}\n   - 기대: ${s.expected}\n   - 실제: ${s.actual}${friction}${shot}`;
    })
    .join("\n");
}

// What the judge must not report again: tickets not merged or closed (rejected ones with their reason),
// causes a group is fixing, and findings still open.
export function knownProblems() {
  const tickets = listTickets();
  const singles = tickets.filter((t) => !t.group && !["merged", "closed"].includes(t.status));
  const groups = tickets.filter((t) => t.group && !["merged", "rejected", "closed"].includes(t.status));
  const findings = listFindings().filter((f) => ["open", "fixing"].includes(f.status));
  const sections = [
    `### 티켓\n\n${singles.map((t) => ticketLine(t, { withScreen: true })).join("\n") || "없음"}`,
    `### 고치기 전인 발견\n\n${findings.map((f) => `- ${f.id} [${f.area}] ${f.title}`).join("\n") || "없음"}`,
  ];
  if (groups.length) {
    sections.push(`### 묶음으로 고치는 중인 원인\n\n${groups.map((g) => `- \`${g.group.cause.key}\` (${g.id}): ${g.group.cause.summary}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

// Use and judge sessions must not change the worktree. Whatever they left is thrown away.
async function discardChanges(wt) {
  await git(wt, ["reset", "--hard", "--quiet", "HEAD"]);
  await git(wt, ["clean", "-fdq"]);
}

const VERDICTS = ["defect", "improvement", "proposal", "agent-error", "intended", "duplicate", "trivial", "not-reproduced"];
const TRACKS = { defect: "fix", improvement: "improve", proposal: "propose" };

// The finding a judgment opens, or null. Nothing below medium opens one: small UI problems are swept
// together by hand (user, 2026-10-26), so a judge that still calls a problem low only drops it.
export function findingOf(j, steps, areas) {
  const track = TRACKS[j.verdict];
  const f = j.finding;
  if (!track || !["high", "medium"].includes(f.severity)) return null;
  const stepArea = steps.find((s) => j.steps.includes(s.n))?.area;
  const area = [f.area, stepArea].find((a) => areas.includes(a)) ?? "files";
  const kind = f.kind === "visual" ? "visual" : "functional";
  return { steps: j.steps, area, severity: f.severity, kind, track, title: f.title, repro: f.repro, expected: f.expected, actual: f.actual, evidence: f.evidence, reason: j.reason };
}

// One exploration: a use session works toward a goal of its own and writes every step, then a judge
// session reproduces the steps that went wrong and turns the defects into findings.
export async function explore() {
  const { implementModel } = settings();
  const base = await gitOut(paths.repo, ["rev-parse", originBase()]);
  const id = String(Date.now());
  const dir = join(paths.sessions, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.json");
  const record = (change) => writeJson(file, { ...readJson(file, {}), ...change });
  const conditions = conditionsFor(listSessions().length - 1);
  const logFile = join(dir, "run.log");
  const label = `${conditions.width}px · ${conditions.theme} · ${conditions.input}`;
  record({ at: now(), base, conditions, status: "using" });
  setLane({ task: "탐색", session: id, title: `자유 탐색 (${label})`, since: now() });
  const wt = await addWorktree("explore", base);
  try {
    const inst = await install(wt, logFile);
    if (inst.code !== 0) throw new Error(`설치 실패\n${tailOf(inst)}`);
    const initPage = await loginInit(wt, dir).catch((e) => {
      requestRepair(`로그인 init page를 만들지 못함\n\n${e.message}`);
      throw e;
    });
    // The runner starts the app first, so a recipe that no longer runs it goes to repair instead of a
    // session that can't see anything. The session finds it running.
    const up = await startDemo(wt);
    if (!up.ok) {
      const tail = existsSync(up.log) ? readFileSync(up.log, "utf8").slice(-2000) : "";
      requestRepair(`탐색 전 앱 시작 실패 (단계 ${up.stage})\n\n${tail}`);
      throw new Error(`앱 시작 실패 (${up.stage}). 실행 지침 수리를 요청했다.`);
    }
    const shared = { toolDir: TOOL_DIR, demoUrl: demoUrl(), workDir: dir, conditions: conditionsText(conditions), areas: areasText() };

    say(`탐색: 사용 세션 (${label})`);
    const goals = recentGoals();
    const used = await runClaude({
      cwd: wt,
      prompt: renderPrompt("use", { ...shared, recentGoals: goals.join("\n") || "없음" }),
      schema: loadSchema("use"),
      model: implementModel,
      shotsDir: join(dir, "shots"),
      logFile,
      timeoutMs: TIMEOUTS.use,
      initPage,
    });
    stopDemo();
    await discardChanges(wt);
    if (!used.ok) throw new EngineError(used.error);
    const use = used.json;
    writeJson(join(dir, "use.json"), { ...use, usage: used.usage });
    // Steps that went wrong, and steps that went as expected with friction an improvement may remove.
    const off = use.steps.filter((s) => !s.matched || s.friction);
    const rough = off.filter((s) => s.matched).length;
    record({ persona: use.persona, goal: use.goal, goalReached: use.goalReached, summary: use.summary, steps: use.steps.length, mismatched: off.length - rough, friction: rough, status: off.length ? "judging" : "done" });
    if (!off.length) return { result: "explored", session: id, goal: use.goal, findings: [] };

    setLane({ task: "판정", session: id, title: use.goal, since: now() });
    say(`탐색: 판정 세션 (${use.steps.length}단계 중 기대와 다른 단계 ${off.length - rough}개${rough ? `, 마찰 ${rough}개` : ""})`);
    const judged = await runClaude({
      cwd: wt,
      prompt: renderPrompt("judge", {
        ...shared,
        useShots: join(dir, "shots"),
        existing: knownProblems(),
        conditions: label,
        persona: use.persona,
        goal: use.goal,
        summary: use.summary,
        steps: stepsText(use.steps),
      }),
      schema: loadSchema("judge"),
      model: implementModel,
      shotsDir: join(dir, "judge-shots"),
      logFile,
      timeoutMs: TIMEOUTS.judge,
      initPage,
    });
    stopDemo();
    await discardChanges(wt);
    if (!judged.ok) throw new EngineError(judged.error);
    writeJson(join(dir, "judge.json"), { ...judged.json, usage: judged.usage });

    const areas = loadScreens().map((s) => s.id);
    const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
    const findings = [];
    for (const j of judged.json.judgments) {
      const found = findingOf(j, use.steps, areas);
      verdicts[TRACKS[j.verdict] && !found ? "trivial" : j.verdict]++;
      if (found) findings.push(createFinding({ session: id, ...found }).id);
    }
    const judgedSteps = new Set(judged.json.judgments.flatMap((j) => j.steps));
    const unjudged = off.filter((s) => !judgedSteps.has(s.n)).map((s) => s.n);
    record({ status: "done", verdicts, unjudged, findings });
    return { result: "explored", session: id, goal: use.goal, findings };
  } catch (e) {
    record({ status: "failed", error: String(e.message ?? e).slice(0, 2000) });
    throw e;
  } finally {
    await removeWorktree(wt);
  }
}

// An improvement is not a defect, so the implementer's rules read differently for it.
export const IMPROVEMENT_NOTE = [
  "#### 이 항목은 개선이다",
  "",
  "결함이 아니라 판정 세션이 고른 기존 흐름의 마찰이다. 아래 규칙은 위 순서보다 먼저 적용한다.",
  "- 재현은 마찰을 다시 겪는 것이다. 순서 2의 `trivial` 판단은 \"처음 쓰는 직원이 막히거나 헷갈릴 만한가\"로 한다.",
  "- 관찰된 마찰만 줄인다. 새 화면·새 데이터·새 설정을 더하지 않고, 금지 경로가 필요하면 `needs-human`으로 끝낸다.",
  "- `functional`이면 재현 테스트는 개선 뒤 동작(줄어든 단계, 바로 보이는 다음 행동, 고친 안내)을 확인하고 지금 코드에서 실패해야 한다.",
  "- 티켓의 \"기대 동작과 실제 동작\"에는 개선 뒤 동작과 지금의 마찰을 쓴다.",
].join("\n");

// The finding as the implement prompt's "고칠 결함".
export function findingText(f) {
  const dir = join(paths.sessions, f.session);
  const c = readJson(join(dir, "session.json"), {}).conditions;
  const improve = f.track === "improve";
  const label = { improve: "[개선] ", propose: "[제안] " }[f.track] ?? "";
  return [
    `### ${f.id} ${label}${f.title}`,
    "",
    `- 심각도: ${f.severity}, 종류: ${f.kind}`,
    c ? `- 찾은 조건: ${c.width}px, ${c.theme}, ${c.input}` : "",
    `- 사용 세션 스크린샷: \`${join(dir, "shots")}\`, 판정 세션 스크린샷: \`${join(dir, "judge-shots")}\``,
    "",
    `#### 재현 절차\n\n${f.repro}`,
    `#### 기대 동작\n\n${f.expected}`,
    `#### 실제 동작\n\n${f.actual}`,
    `#### 판정 근거\n\n${f.evidence}`,
    improve ? IMPROVEMENT_NOTE : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// Fixes one open finding: implement → gate → review, as before. A finding the implementer can't
// reproduce, or finds trivial, is dropped; one it can't fix within the tries is blocked.
export async function fixFinding(finding) {
  if (finding.track === "propose") return proposeFinding(finding);
  const { implementModel } = settings();
  const screen = loadScreens().find((s) => s.id === finding.area);
  updateFinding(finding.id, { status: "fixing" });
  const base = await gitOut(paths.repo, ["rev-parse", originBase()]);
  const workDir = join(paths.runs, "work", `${Date.now()}-${finding.id}`);
  mkdirSync(workDir, { recursive: true });
  const wt = await addWorktree(finding.id, base);
  try {
    const inst = await install(wt, join(workDir, "run.log"));
    if (inst.code !== 0) throw new Error(`설치 실패\n${tailOf(inst)}`);
    const built = await buildCandidate({ screen, base, wt, workDir, engine: "claude", model: implementModel, mission: findingText(finding) });
    if (built.found === false) {
      updateFinding(finding.id, { status: "dropped", reason: built.notes || "구현 세션이 재현하지 못함" });
      rmSync(workDir, { recursive: true, force: true });
      return { result: "finding-dropped", finding: finding.id, screen: screen.id };
    }
    if (built.blocked) {
      updateFinding(finding.id, { status: "blocked", reason: built.reason });
      return { result: "blocked", finding: finding.id, screen: screen.id, reason: built.reason, workDir };
    }
    if (built.needsHuman) {
      const out = await needsHumanTicket({ screen, base, wt, workDir, built, implementModel, finding: finding.id, track: finding.track ?? "fix" });
      updateFinding(finding.id, { status: "ticketed", ticket: out.ticket });
      return { ...out, finding: finding.id };
    }

    const id = nextTicketId();
    const tdir = ticketDir(id);
    const adir = join(tdir, "attempts", "1");
    mkdirSync(join(tdir, "attempts"), { recursive: true });
    renameSync(workDir, adir);
    const branch = `qa/${id}-a1`;
    await bundle(join(adir, "candidate.bundle"), branch, built.sha, base);
    writeTicketFiles(adir, built);
    cpSync(join(adir, "ticket.md"), join(tdir, "ticket.md"));
    createTicket({
      id,
      screen: screen.id,
      finding: finding.id,
      track: finding.track ?? "fix",
      status: "awaiting",
      title: built.result.title,
      kind: built.result.kind,
      severity: built.result.severity,
      attempt: 1,
      base,
      candidate: built.sha,
      branch,
      prTitle: built.result.prTitle,
      branchSlug: built.result.branchSlug,
      implement: { engine: "claude", model: implementModel },
      review: { engine: "codex", model: settings().reviewModel },
      feedback: null,
      rejectReason: null,
      pr: null,
      createdAt: now(),
      updatedAt: now(),
    });
    updateFinding(finding.id, { status: "ticketed", ticket: id });
    return { result: "ticket", ticket: id, finding: finding.id };
  } finally {
    await removeWorktree(wt);
  }
}

// A finding the agent should not decide alone. No candidate to approve; the human rejects it or
// gives a direction with revise. Counts toward the human-waiting cap.
async function needsHumanTicket({ screen, base, wt, workDir, built, implementModel, finding, track }) {
  const id = nextTicketId();
  const tdir = ticketDir(id);
  const adir = join(tdir, "attempts", "1");
  mkdirSync(join(tdir, "attempts"), { recursive: true });
  renameSync(workDir, adir);
  if (built.sha) writeFileSync(join(adir, "diff.patch"), (await git(wt, ["diff", "-M", base, built.sha])).stdout);
  if (built.gate) writeJson(join(adir, "files.json"), built.gate.files);
  const res = built.result;
  const body = res.ticket?.trim() || `# ${res.title || "판단이 필요한 결함"}`;
  writeFileSync(join(tdir, "ticket.md"), `${body}\n\n## 사람 판단이 필요한 이유\n\n${built.needsHuman}\n`);
  createTicket({
    id,
    screen: screen.id,
    finding,
    track,
    status: "needs-human",
    title: res.title || "판단이 필요한 결함",
    kind: res.kind,
    severity: res.severity,
    attempt: 1,
    base,
    candidate: null,
    branch: null,
    prTitle: res.prTitle,
    branchSlug: res.branchSlug,
    needsHumanReason: built.needsHuman,
    implement: { engine: "claude", model: implementModel },
    review: { engine: "codex", model: settings().reviewModel },
    feedback: null,
    rejectReason: null,
    pr: null,
    createdAt: now(),
    updatedAt: now(),
  });
  return { result: "needs-human", ticket: id, reason: built.needsHuman };
}

// ---------- feature proposals (2026-10-26) ----------

// A spec's own sections pushed down, so it can sit under a section of the given level.
const demote = (md, under = 2) => md.trim().replace(/^(#+) /gm, (_, h) => `${"#".repeat(h.length + under - 1)} `);

// The proposal ticket's body: the spec, and the part the agent may not build when there is one.
export function proposalTicket(res) {
  const human = res.forbidden.length
    ? `\n\n## 사람이 구현할 부분\n\n추천안이 에이전트가 바꿀 수 없는 경로를 건드린다: ${res.forbidden.map((f) => `\`${f}\``).join(", ")}`
    : "";
  return `# ${res.title}\n\n${res.spec.trim()}${human}\n`;
}

// The implement section for an approved spec. The spec's 완료 기준 take the place of a repro.
export function specFeedback(spec) {
  return `## 이번 작업: 승인된 기능 제안 구현

이 절은 아래 "순서"보다 우선한다. 사람이 아래 제안서를 승인했다. 새 결함을 찾지 않고 제안서의 추천안만 구현한다.
- 재현 대신 제안서의 "완료 기준"을 쓴다. 항목마다 그 동작을 확인하는 테스트를 쓴다. 테스트는 지금 main에서 실패하고
  구현 뒤 통과해야 한다. 재현 테스트의 위치와 횟수 규칙은 그대로 따른다.
- "하지 않을 것"과 추천안 밖의 동작은 바꾸지 않는다.
- 바꿀 수 없는 경로가 필요해지면 우회하지 말고 \`status="needs-human"\`으로 끝내고 \`reason\`에 필요한 변경을 쓴다.
- 결과는 \`status="fixed"\`, \`severity="medium"\`으로 낸다. 티켓의 "재현 절차"에는 완료 기준을 확인하는 절차를,
  "기대 동작과 실제 동작"에는 구현 뒤 동작과 지금 동작을 쓴다.

### 승인된 제안

${demote(spec, 3)}`;
}

// Proposals made in the last day, against PROPOSALS_PER_DAY.
export function proposalsToday(tickets, at = Date.now()) {
  return tickets.filter((t) => t.track === "propose" && at - Date.parse(t.createdAt) < 24 * 60 * 60 * 1000).length;
}

// One spec session on the latest main. It reads the product docs and code; it writes nothing.
async function writeSpec({ finding, feedback, workDir, excludeTicket }) {
  const base = await gitOut(paths.repo, ["rev-parse", originBase()]);
  const wt = await addWorktree(`propose-${excludeTicket ?? "new"}`, base);
  try {
    const r = await runClaude({
      cwd: wt,
      prompt: renderPrompt("propose", {
        toolDir: TOOL_DIR,
        demoUrl: demoUrl(),
        workDir,
        allowed: currentRecipe().paths.allowed.join(", "),
        forbidden: currentRecipe().paths.forbidden.join(", "),
        maxFiles: PROPOSAL_LIMITS.files,
        maxLines: PROPOSAL_LIMITS.lines,
        areas: areasText(),
        existing: knownProblems(),
        finding,
        feedback,
      }),
      schema: loadSchema("propose"),
      model: settings().implementModel,
      shotsDir: join(workDir, "shots"),
      logFile: join(workDir, "run.log"),
      timeoutMs: TIMEOUTS.propose,
    });
    stopDemo();
    await discardChanges(wt);
    if (!r.ok) throw new EngineError(r.error);
    writeJson(join(workDir, "propose.json"), { ...r.json, usage: r.usage });
    return { base, res: r.json };
  } finally {
    await removeWorktree(wt);
  }
}

// A proposal finding becomes a ticket that holds a spec and no code. The human approves the spec
// before anything is built (human.mjs approve), or drops it when it lacks a product reason.
async function proposeFinding(finding) {
  updateFinding(finding.id, { status: "fixing" });
  const workDir = join(paths.runs, "work", `${Date.now()}-${finding.id}`);
  mkdirSync(workDir, { recursive: true });
  const { base, res } = await writeSpec({ finding: findingText(finding), feedback: "", workDir });
  if (res.status === "drop" || !res.spec.trim()) {
    updateFinding(finding.id, { status: "dropped", reason: res.reason || "제안서 세션이 버림" });
    rmSync(workDir, { recursive: true, force: true });
    return { result: "finding-dropped", finding: finding.id, reason: res.reason };
  }
  const id = nextTicketId();
  const tdir = ticketDir(id);
  mkdirSync(join(tdir, "proposals"), { recursive: true });
  renameSync(workDir, join(tdir, "proposals", "1"));
  writeFileSync(join(tdir, "proposal.md"), res.spec.trim());
  writeFileSync(join(tdir, "ticket.md"), proposalTicket(res));
  const areas = loadScreens().map((s) => s.id);
  createTicket({
    id,
    screen: areas.includes(res.area) ? res.area : finding.area,
    finding: finding.id,
    track: "propose",
    status: "proposal",
    title: res.title,
    kind: "functional",
    severity: "medium",
    attempt: 0,
    base,
    candidate: null,
    branch: null,
    prTitle: res.prTitle,
    branchSlug: res.branchSlug,
    proposal: { version: 1, forbidden: res.forbidden, note: res.reason },
    implement: { engine: "claude", model: settings().implementModel },
    review: { engine: "codex", model: settings().reviewModel },
    feedback: null,
    rejectReason: null,
    pr: null,
    createdAt: now(),
    updatedAt: now(),
  });
  updateFinding(finding.id, { status: "ticketed", ticket: id });
  return { result: "proposal", ticket: id, finding: finding.id };
}

// The human's direction on a spec rewrites the spec; nothing is built until it is approved.
async function reviseProposal(ticket) {
  const tdir = ticketDir(ticket.id);
  const n = (ticket.proposal?.version ?? 1) + 1;
  const workDir = join(tdir, "proposals", String(n));
  mkdirSync(workDir, { recursive: true });
  const feedback = `## 이번 작업: 사람이 준 방향으로 제안서 다시 쓰기

사람이 아래 이전 제안서를 읽고 방향을 줬다. 그 방향대로 제안서를 처음부터 다시 쓴다. 규칙 2·3으로 버리지 않는다.
방향대로 쓸 수 없으면 \`status="drop"\`으로 끝내고 \`reason\`에 이유를 쓴다.

### 이전 제안서

${demote(readFileSync(join(tdir, "proposal.md"), "utf8"), 3)}

### 사람이 준 방향

${ticket.feedback}`;
  const finding = readFinding(ticket.finding);
  const { base, res } = await writeSpec({ finding: finding ? findingText(finding) : `### ${ticket.title}`, feedback, workDir, excludeTicket: ticket.id });
  if (res.status === "drop" || !res.spec.trim()) {
    transition(ticket.id, "revising", { status: "proposal", reviseFrom: null, reviseNote: `제안서를 다시 쓰지 못함: ${res.reason}`, lastReviseFailed: now() });
    return { result: "revise-blocked", ticket: ticket.id, reason: res.reason };
  }
  writeFileSync(join(tdir, "proposal.md"), res.spec.trim());
  writeFileSync(join(tdir, "ticket.md"), proposalTicket(res));
  transition(ticket.id, "revising", {
    status: "proposal",
    reviseFrom: null,
    reviseNote: null,
    base,
    title: res.title,
    prTitle: res.prTitle,
    branchSlug: res.branchSlug,
    proposal: { version: n, forbidden: res.forbidden, note: res.reason },
  });
  return { result: "revised", ticket: ticket.id };
}

// ---------- revise ----------

export async function revise(ticket) {
  if (ticket.group) return buildGroup(ticket);
  if (ticket.reviseFrom === "proposal" && !ticket.specApproved) return reviseProposal(ticket);
  const own = loadScreens().find((s) => s.id === ticket.screen);
  const screen = ticket.setup ? setupScope(own, currentRecipe()) : own;
  const tdir = ticketDir(ticket.id);
  const n = ticket.attempt + 1;
  // An approved spec has no candidate yet, so it is built on the latest main.
  const fresh = ticket.rebase || ticket.specApproved;
  if (fresh) await fetchOrigin();
  const base = fresh ? await gitOut(paths.repo, ["rev-parse", originBase()]) : ticket.base;
  const workDir = join(paths.runs, "work", `${Date.now()}-${ticket.id}-a${n}`);
  mkdirSync(workDir, { recursive: true });
  const spec = existsSync(join(tdir, "proposal.md")) ? readFileSync(join(tdir, "proposal.md"), "utf8") : null;
  const original = problemOnly(readFileSync(join(tdir, "ticket.md"), "utf8"));
  const feedback = ticket.specApproved ? specFeedback(spec) : `## 이번 작업: 수정 요청에 따른 재구현

이 절은 아래 "순서"보다 우선한다. 새 결함을 찾지 않고 아래 "원래 문제"만 다룬다.
결함인지, 고칠 가치가 있는지는 사람이 이미 판단했다. 심각도가 낮아 보여도 고친다.
화면은 원래 문제의 재현 조건에서만 본다. before·after 스크린샷과 재현 테스트 규칙은 그대로 따른다.
결과는 \`status="fixed"\`로 낸다. 사람이 준 방향으로 고칠 수 없으면 \`status="needs-human"\`으로 끝내고
\`reason\`에 이유를 쓴다. \`status="none"\`은 쓰지 않는다. 이전에 시도한 수정은 버려졌다. 처음부터 새로 설계한다.

### 원래 문제

${original}
${spec ? `\n### 승인된 제안\n\n${demote(spec, 3)}\n` : ""}
### 사람이 준 방향

${ticket.feedback}`;
  const wt = await addWorktree(`${ticket.id}-a${n}`, base);
  try {
    const inst = await install(wt, join(workDir, "run.log"));
    if (inst.code !== 0) throw new Error(`설치 실패\n${tailOf(inst)}`);
    const built = await buildCandidate({
      screen,
      base,
      wt,
      workDir,
      engine: ticket.implement.engine,
      model: ticket.implement.model,
      firstFeedback: feedback,
      mustFind: true,
      excludeTicket: ticket.id,
      limits: spec ? PROPOSAL_LIMITS : undefined,
    });
    if (!built.ok) {
      const reason = built.needsHuman ? `사람 판단 필요: ${built.needsHuman}` : (built.reason ?? "결함을 다시 구현하지 못함.");
      writeFileSync(join(tdir, "ticket.md"), `${readFileSync(join(tdir, "ticket.md"), "utf8")}\n\n## 재구현 실패 (attempt ${n})\n\n${reason}\n`);
      // Back to where the revise came from: an approvable candidate or a needs-human finding.
      transition(ticket.id, "revising", {
        status: ticket.reviseFrom ?? "awaiting",
        lastReviseFailed: now(),
        reviseNote: reason,
        reviseAdvice: built.advice ?? null,
        rebase: false,
        reviseFrom: null,
        specApproved: false,
      });
      keepFailed(tdir, workDir, n);
      return { result: "revise-blocked", ticket: ticket.id, reason };
    }
    const adir = join(tdir, "attempts", String(n));
    renameSync(workDir, adir);
    const branch = `qa/${ticket.id}-a${n}`;
    await bundle(join(adir, "candidate.bundle"), branch, built.sha, base);
    writeTicketFiles(adir, built, { feedback: ticket.feedback });
    const ticketMd = readFileSync(join(adir, "ticket.md"), "utf8");
    writeFileSync(join(tdir, "ticket.md"), spec ? `${ticketMd.trimEnd()}\n\n## 승인된 제안\n\n${demote(spec)}\n` : ticketMd);
    if (ticket.branch) await run("git", ["branch", "-D", ticket.branch], { cwd: paths.repo });
    transition(ticket.id, "revising", {
      status: "awaiting",
      reviseFrom: null,
      reviseNote: null,
      reviseAdvice: null,
      needsHumanReason: null,
      attempt: n,
      base,
      candidate: built.sha,
      branch,
      title: spec ? ticket.title : built.result.title,
      kind: built.result.kind,
      severity: spec ? ticket.severity : built.result.severity,
      prTitle: spec ? ticket.prTitle : built.result.prTitle,
      branchSlug: spec ? ticket.branchSlug : built.result.branchSlug,
      rebase: false,
      specApproved: false,
    });
    return { result: "revised", ticket: ticket.id };
  } finally {
    await removeWorktree(wt);
  }
}

// ---------- group ----------

// The implement section for a group: the tickets it took over, then the cause fixed at its source and
// found everywhere else it shows up. A human revise adds their direction.
export function groupFeedback(ticket, limits = GROUP_LIMITS) {
  const { cause, members } = ticket.group;
  const problems = members
    .map((id) => {
      const file = join(ticketDir(id), "ticket.md");
      const body = existsSync(file) ? problemOnly(readFileSync(file, "utf8")) : "";
      return `### ${id}\n\n${body.replace(/^# /, "#### ")}`;
    })
    .join("\n\n");
  const human = ticket.feedback ? `\n\n### 사람이 준 방향\n\n${ticket.feedback}` : "";
  return `## 이번 작업: 같은 원인 결함 묶음 처리

이 절은 아래 "순서"보다 우선한다. 화면 하나를 새로 탐색하지 않는다.
아래 티켓 ${members.length}건은 근본 원인이 같다고 분류됐다. 원인: ${cause.summary} (\`${cause.key}\`)
목표는 이 원인을 원천에서 고쳐, 묶은 결함과 같은 원인으로 생기는 다른 결함까지 한 번에 없애는 것이다.
결함인지, 고칠 가치가 있는지는 이미 정해졌다. 각 티켓의 이전 수정 후보는 버려졌다. 처음부터 설계한다.

### 묶음 순서

1. 묶은 티켓을 하나씩 재현한다. 재현되지 않는 티켓은 \`notes\`에 적는다.
2. 원인이 정말 같은지 코드로 확인한다. 원인이 다른 티켓은 고치지 않고 \`notes\`에 이유를 적는다.
   공통 원인이 없거나, 원천에서 고치려면 금지 경로를 바꿔야 하면 \`status="needs-human"\`으로 끝낸다.
3. 같은 원인으로 생기는 다른 곳을 찾는다. 묶은 티켓의 화면만 보지 않는다. \`${currentRecipe().app.root}\` 전체에서 같은
   구조(같은 컴포넌트·hook 사용, 같은 코드 패턴)를 검색하고, 위치마다 결함이 실제로 생기는지 코드와 브라우저로
   확인한다. 찾은 곳과 확인 방법을 목록으로 남긴다.
4. 원인을 원천에서 고친다. 화면마다 같은 방어 코드를 덧대지 않는다. 공통 컴포넌트·hook·유틸을 한 번 고쳐 묶은
   결함과 3단계에서 찾은 곳이 함께 해결되게 한다. 공통 규칙으로 정할 수 없는 곳만 화면별로 고친다.
5. 묶은 티켓마다 재현 테스트를 아래 "순서" 8단계 규칙대로 쓴다. 공통 코드를 고쳤으므로 그 코드의 unit test나
   기존 spec에 더하는 것을 먼저 고른다. 3단계에서 찾은 곳 중 사용자가 자주 지나는 경로는 기존 spec에 test를 더한다.
   모든 재현 테스트는 고치기 전 코드에서 실패해야 한다.
6. 화면 확인, 스크린샷, lint·typecheck·spec 실행은 아래 "순서" 7~11단계를 따른다. 화면 하나가 아니라 묶은 티켓의
   화면과 3단계에서 고친 화면을 본다. 결함 종류는 하나라도 \`functional\`이면 \`functional\`이다.
7. 이 작업의 변경 상한은 파일 ${limits.files}개, 추가·삭제 ${limits.lines}줄(테스트 포함, proof spec 제외)이다. 위 "작업 위치와
   규칙"의 상한 대신 이 값을 따른다.

### 묶음 결과

- 고쳤으면 \`status="fixed"\`로 낸다. \`status="none"\`은 쓰지 않는다.
- \`title\`: 원인을 사용자가 겪는 결함으로 한 줄에 쓴다. 티켓 번호는 넣지 않는다.
- \`ticket\`: 티켓 작성 규칙을 따르고 두 절을 더한다. \`## 묶은 티켓\`에는 티켓 번호, 제목, 재현 여부를 쓴다.
  \`## 같은 원인으로 함께 고친 곳\`에는 3단계에서 찾아 고친 곳마다 화면, 조작, 고친 뒤 결과를 한 줄씩 쓴다.
  찾았지만 고치지 않은 곳은 이유와 함께 \`notes\`에 쓴다.
- \`prBody\`: Why에 묶은 티켓 번호와 원인을, Changes에 공통 수정과 함께 고친 곳을 쓴다.

### 묶은 티켓

${problems}${human}`;
}

// Builds the group's candidate from the latest main: first for a new or grown group (grouping), again
// after a human revise. A failed first build asks the human; a failed revise returns to where it was.
export async function buildGroup(ticket) {
  const from = ticket.status;
  const screen = ticketScreen(ticket);
  const tdir = ticketDir(ticket.id);
  const n = ticket.attempt + 1;
  await fetchOrigin();
  const base = await gitOut(paths.repo, ["rev-parse", originBase()]);
  const workDir = join(paths.runs, "work", `${Date.now()}-${ticket.id}-a${n}`);
  mkdirSync(workDir, { recursive: true });
  const wt = await addWorktree(`${ticket.id}-a${n}`, base);
  try {
    const inst = await install(wt, join(workDir, "run.log"));
    if (inst.code !== 0) throw new Error(`설치 실패\n${tailOf(inst)}`);
    const built = await buildCandidate({
      screen,
      base,
      wt,
      workDir,
      engine: ticket.implement.engine,
      model: ticket.implement.model,
      firstFeedback: groupFeedback(ticket),
      mustFind: true,
      excludeTicket: [ticket.id, ...ticket.group.members],
      limits: GROUP_LIMITS,
      timeoutMs: TIMEOUTS.group,
    });
    if (!built.ok) {
      const reason = built.needsHuman ? `사람 판단 필요: ${built.needsHuman}` : (built.reason ?? "묶음을 구현하지 못함.");
      keepFailed(tdir, workDir, n);
      const advice = built.advice ?? null;
      if (from === "revising") {
        writeFileSync(join(tdir, "ticket.md"), `${readFileSync(join(tdir, "ticket.md"), "utf8")}\n\n## 재구현 실패 (attempt ${n})\n\n${reason}\n`);
        transition(ticket.id, "revising", { status: ticket.reviseFrom ?? "awaiting", lastReviseFailed: now(), reviseNote: reason, reviseAdvice: advice, reviseFrom: null });
        return { result: "revise-blocked", ticket: ticket.id, reason };
      }
      const members = ticket.group.members.map((id) => `- ${id}`).join("\n");
      writeFileSync(join(tdir, "ticket.md"), `# ${ticket.title}\n\n## 묶은 티켓\n\n${members}\n\n## 사람 판단이 필요한 이유\n\n${reason}\n`);
      transition(ticket.id, "grouping", { status: "needs-human", needsHumanReason: reason, reviseAdvice: advice, attempt: n, base });
      return { result: "group-blocked", ticket: ticket.id, reason };
    }
    const adir = join(tdir, "attempts", String(n));
    mkdirSync(join(tdir, "attempts"), { recursive: true });
    renameSync(workDir, adir);
    const branch = `qa/${ticket.id}-a${n}`;
    await bundle(join(adir, "candidate.bundle"), branch, built.sha, base);
    writeTicketFiles(adir, built, { feedback: ticket.feedback, group: ticket.group });
    cpSync(join(adir, "ticket.md"), join(tdir, "ticket.md"));
    if (ticket.branch) await run("git", ["branch", "-D", ticket.branch], { cwd: paths.repo });
    transition(ticket.id, from, {
      status: "awaiting",
      reviseFrom: null,
      reviseNote: null,
      reviseAdvice: null,
      needsHumanReason: null,
      attempt: n,
      base,
      candidate: built.sha,
      branch,
      title: built.result.title,
      kind: built.result.kind,
      severity: built.result.severity === "trivial" ? ticket.severity : built.result.severity,
      prTitle: built.result.prTitle,
      branchSlug: built.result.branchSlug,
      rebase: false,
    });
    return { result: from === "revising" ? "revised" : "group-built", ticket: ticket.id };
  } finally {
    await removeWorktree(wt);
  }
}

// ---------- PR fix round ----------

// First line of a Codex inline comment, e.g. "**<sub><sub>![P2 Badge](…)</sub></sub>  Title**" → "[P2] Title".
export function findingHeadline(body) {
  const first = String(body ?? "").split("\n").find((l) => l.trim()) ?? "";
  const level = first.match(/!\[(P\d)[^\]]*\]/)?.[1];
  const title = first
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<\/?sub>/g, "")
    .replace(/\*\*/g, "")
    .trim();
  return `${level ? `[${level}] ` : ""}${title}`;
}

// What earlier rounds of this PR asked for and how each was handled, so a repeated finding is visible.
export function priorRounds(tdir, round) {
  const lines = [];
  for (let r = 1; r < round; r++) {
    const dir = join(tdir, "pr-rounds", String(r));
    const req = readJson(join(dir, "request.json"), null);
    const res = readJson(join(dir, "result.json"), null);
    if (!req) continue;
    if (req.humanFeedback) lines.push(`- 라운드 ${r} 사람 피드백: ${req.humanFeedback.split("\n")[0]}`);
    if (req.conflict) lines.push(`- 라운드 ${r} main 충돌 해결`);
    for (const c of req.ciFailures ?? []) lines.push(`- 라운드 ${r} CI 실패: ${c.name}`);
    for (const f of req.findings ?? []) {
      const done = res?.comments?.find((x) => x.commentId === f.id);
      lines.push(`- 라운드 ${r} \`${f.path}\`: ${findingHeadline(f.body)} → ${done?.action ?? "답 없음"}`);
    }
  }
  return lines.join("\n") || "없음";
}

function requestText(req) {
  const parts = [];
  if (req.humanFeedback) parts.push(`### 사람 피드백 (가장 먼저 반영)\n\n${req.humanFeedback}`);
  if (req.conflict) parts.push(`### ${currentRecipe().baseBranch}과 충돌\n\n\`git merge --no-commit ${originBase()}\`으로 병합하고 충돌을 해결한다. merge commit은 실행기가 만든다.`);
  if (req.findings?.length) {
    parts.push(
      `### Codex 지적\n\n${req.findings.map((f) => `- commentId ${f.id} — \`${f.path}${f.line ? `:${f.line}` : ""}\`\n\n${f.body.replace(/^/gm, "  > ")}`).join("\n\n")}`,
    );
  }
  if (req.ciFailures?.length) {
    parts.push(`### CI 실패\n\n${req.ciFailures.map((c) => `- ${c.name}\n\n\`\`\`\n${c.log || "(로그 없음)"}\n\`\`\``).join("\n\n")}`);
  }
  return parts.join("\n\n") || "없음";
}

// Commits whatever the session left. With MERGE_HEAD present (after `git merge --no-commit`)
// this records a merge commit with both parents. Returns HEAD.
export async function commitFixRound(wt, message) {
  await git(wt, ["add", "-A"]);
  const dirty = (await run("git", ["diff", "--cached", "--quiet"], { cwd: wt })).code !== 0;
  const merging = (await run("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: wt })).code === 0;
  if (dirty || merging) await git(wt, ["commit", "--quiet", "--no-verify", "-m", message]);
  return gitOut(wt, ["rev-parse", "HEAD"]);
}

// A round waits in the PR lane after watch wrote its request. A push in between (an update from
// main, a redeploy) may have fixed what the request lists, so watch judges the new head again.
// The human's feedback is about the PR, not a head, and still runs.
export function staleRequest(req, prHead) {
  return req.head !== prHead && !req.humanFeedback;
}

export async function prFix(ticket) {
  const screen = ticketScreen(ticket);
  const tdir = ticketDir(ticket.id);
  const round = ticket.pr.round + 1;
  const rdir = join(tdir, "pr-rounds", String(round));
  const req = readJson(join(rdir, "request.json"), null);
  if (!req) throw new Error(`${ticket.id}: pr-rounds/${round}/request.json 없음`);
  const logFile = join(rdir, "run.log");
  const shotsDir = join(rdir, "shots");
  await fetchOrigin();
  const prHead = await gitOut(paths.repo, ["rev-parse", `origin/${ticket.pr.branch}`]);
  if (staleRequest(req, prHead)) {
    rmSync(rdir, { recursive: true, force: true });
    transition(ticket.id, "pr-fixing", { status: "pr-review", pr: { ...ticket.pr, head: prHead, pushedAt: new Date().toISOString() } });
    return { result: "pr-fix-stale", ticket: ticket.id, head: prHead.slice(0, 7) };
  }
  const wt = await addWorktree(`${ticket.id}-r${round}`, prHead);
  const fail = (reason) => {
    transition(ticket.id, "pr-fixing", { status: "final-review", finalNotified: false, prNote: `수정 라운드 ${round} 실패: ${reason}` });
    return { result: "pr-fix-failed", ticket: ticket.id, reason };
  };
  try {
    await git(wt, ["checkout", "--quiet", "-B", `pr/${ticket.id}`]);
    const inst = await install(wt, logFile);
    if (inst.code !== 0) throw new Error(`설치 실패\n${tailOf(inst)}`);
    const initPage = await loginInit(wt, rdir);
    let note = "";
    for (let attempt = 1; attempt <= MAX_FIX_TRIES; attempt++) {
      say(`${ticket.id}: PR 수정 라운드 ${round}, 세션 ${attempt}/${MAX_FIX_TRIES}`);
      const prompt = renderPrompt("pr-fix", {
        allowed: screen.paths.join(", "),
        forbidden: currentRecipe().paths.forbidden.join(", "),
        toolDir: TOOL_DIR,
        demoUrl: demoUrl(),
        specs: screen.specs.join(", ") || "없음",
        shotsDir,
        request: requestText(req) + note,
        history: priorRounds(tdir, round),
        ticket: readFileSync(join(tdir, "ticket.md"), "utf8"),
      });
      const r = await runClaude({ cwd: wt, prompt, schema: loadSchema("pr-fix"), model: ticket.implement.model ?? settings().implementModel, shotsDir, logFile, timeoutMs: TIMEOUTS.prFix, initPage });
      stopDemo();
      if (!r.ok) throw new EngineError(r.error);
      writeJson(join(rdir, `fix-${attempt}.json`), { ...r.json, usage: r.usage });
      if (r.json.status === "needs-human") return fail(`사람 판단 필요: ${r.json.reason || "이유 없음"}`);
      const head = await commitFixRound(wt, `fix: address review round ${round}`);
      const onlyReplies = head === prHead;
      if (onlyReplies && r.json.comments.some((c) => c.action === "fixed")) {
        note = `\n\n${retryNote("`fixed`로 답한 지적이 있는데 바뀐 코드가 없다.")}`;
        continue;
      }
      let gate = { ok: true, steps: [] };
      if (!onlyReplies) {
        const mergeBase = await gitOut(wt, ["merge-base", originBase(), "HEAD"]);
        gate = await runGate({ wt, base: mergeBase, screen, kind: "pr", explainedTests: r.json.changedTestsReason, logFile, full: false });
        writeJson(join(rdir, `gate-${attempt}.json`), gate);
      }
      if (gate.needsHuman) return fail(`사람 판단 필요: ${gate.needsHuman}`);
      if (!gate.ok) {
        note = `\n\n${retryNote(`실행기 검사 실패\n${gateSummary(gate)}`)}`;
        continue;
      }
      if (!onlyReplies) await bundle(join(rdir, "fix.bundle"), `pr/${ticket.id}`, head, prHead);
      writeJson(join(rdir, "result.json"), {
        ...r.json,
        prHead,
        head,
        shots: r.json.uiChanged ? shotsOnly(shotsDir) : [],
      });
      transition(ticket.id, "pr-fixing", { status: "pr-push" });
      return { result: "pr-fixed", ticket: ticket.id, round };
    }
    return fail(note.trim() || "검사를 통과하지 못함");
  } finally {
    await removeWorktree(wt);
  }
}

// ---------- main health ----------

// Runs the recipe's checks once per base branch commit, so a broken base is not blamed on candidates.
// A check that fails runs once more; only a second failure marks main broken (one flaky test stopped
// exploring on 2026-10-19).
export async function baseCheck(sha) {
  mkdirSync(paths.baseChecks, { recursive: true });
  const key = `${sha}-${recipeHash(currentRecipe())}`;
  const file = join(paths.baseChecks, `${key}.json`);
  const cached = readJson(file, null);
  if (cached) return cached;
  say(`main ${sha.slice(0, 7)} 기준 검사`);
  const logFile = join(paths.baseChecks, `${key}.log`);
  const wt = await addWorktree("main-check", sha);
  try {
    const inst = await install(wt, logFile);
    // Installing the base itself failing is the recipe's problem, not a broken base commit.
    if (inst.code !== 0) {
      requestRepair(`base ${sha.slice(0, 7)} 설치 실패\n\n${tailOf(inst)}`);
      return { sha, ok: false, failed: ["설치"], at: now() };
    }
    const failed = [];
    for (const check of currentRecipe().checks) {
      if ((await repoCheck(wt, check, logFile)).code === 0) continue;
      appendFileSync(logFile, `\n--- ${check.name} 실패, 한 번 더 실행 ---\n`);
      if ((await repoCheck(wt, check, logFile)).code !== 0) failed.push(check.name);
    }
    const result = { sha, ok: failed.length === 0, failed, at: now() };
    writeJson(file, result);
    return result;
  } finally {
    await removeWorktree(wt);
  }
}

// ---------- loop ----------

async function cleanupBranches(tickets) {
  for (const t of tickets) {
    if (!["rejected", "merged", "closed"].includes(t.status) || t.branchesCleaned) continue;
    const refs = (await gitOut(paths.repo, ["for-each-ref", "--format=%(refname:short)", `refs/heads/qa/${t.id}-*`, `refs/heads/pr/${t.id}`])).split("\n").filter(Boolean);
    for (const ref of refs) await run("git", ["branch", "-D", ref], { cwd: paths.repo });
    transition(t.id, t.status, { branchesCleaned: true });
  }
}

// What a lane is doing now, for `fieldtest status` and the dashboard (state.lanes).
function setLane(current) {
  const s = readState();
  writeState({ ...s, lanes: { ...(s.lanes ?? {}), [currentLane().name]: current } });
}

async function work(task, t, fn) {
  setLane({ task, ticket: t.id, screen: t.screen, since: now() });
  try {
    return await fn();
  } finally {
    setLane(null);
  }
}

// PR lane: short and human-facing work, so it never waits behind an exploration. Cards come first;
// they take seconds and the human reads them.
// The server's Codex review of one PR head (design §10). Reads the diff, writes the result; watch posts it.
export async function reviewPr(ticket, head) {
  const rdir = join(ticketDir(ticket.id), "pr-reviews");
  const logFile = join(rdir, `${head}.log`);
  await fetchOrigin();
  const wt = await addWorktree(`${ticket.id}-review`, head);
  try {
    const base = await gitOut(wt, ["merge-base", originBase(), "HEAD"]);
    const diff = (await git(wt, ["diff", "-M", base, "HEAD"])).stdout;
    const diffFile = join(rdir, `${head}.diff`);
    writeFileSync(diffFile, diff);
    const ticketMd = join(ticketDir(ticket.id), "ticket.md");
    const res = await runCodex({
      cwd: wt,
      prompt: renderPrompt("pr-review", { diffFile, ticket: existsSync(ticketMd) ? readFileSync(ticketMd, "utf8") : ticket.title }),
      schemaName: "pr-review",
      model: settings().reviewModel,
      shotsDir: join(rdir, `${head}-shots`),
      logFile,
      timeoutMs: TIMEOUTS.review,
    });
    if (!res.ok) throw new EngineError(res.error);
    writeReviewResult(ticket.id, head, { summary: res.json.summary, findings: reviewFindings(res.json, diff) });
    return { result: "pr-reviewed", ticket: ticket.id, head: head.slice(0, 7), findings: res.json.findings.length };
  } catch (e) {
    if (reviewFailed(ticket.id, head, String(e.message ?? e).slice(0, 1500))) return { result: "pr-review-failed", ticket: ticket.id, head: head.slice(0, 7) };
    throw e;
  } finally {
    await removeWorktree(wt);
  }
}

export async function prIteration() {
  const tickets = listTickets();
  const asked = pendingReviews(tickets)[0];
  if (asked) {
    const t = tickets.find((x) => x.id === asked.id);
    return work("PR 리뷰", t, () => reviewPr(t, asked.head));
  }
  const uncarded = tickets.find(needsCard);
  if (uncarded) return work("카드 작성", uncarded, () => makeCard(uncarded));
  const fixing = tickets.find((t) => t.status === "pr-fixing");
  if (fixing) {
    await fetchOrigin();
    return work("PR 수정", fixing, () => prFix(fixing));
  }
  const uncaused = tickets.find(needsCause);
  if (uncaused) return work("원인 분류", uncaused, () => classifyCause(uncaused, tickets));
  const plan = groupPlan(tickets);
  if (plan) return applyGroupPlan(tickets, plan);
  return { result: "idle", wait: LANE_IDLE_MS };
}

// Exploration lane: rebuilds the human asked for, group builds, open findings, then a new exploration.
// It never waits for a cooldown; only the approval cap and a broken main stop it (design §3).
// The recipe's repair, in the exploration lane (design §8.4). PR fix rounds go on meanwhile.
async function runRepair(reason) {
  setLane({ task: "실행 지침 수리", title: reason.split("\n")[0], since: now() });
  try {
    const r = await bootstrap({ feedback: reason });
    return { result: r.ok ? "recipe-repaired" : "recipe-repair-failed", error: r.error ?? null };
  } finally {
    setLane(null);
  }
}

// The proposal for a repo without Playwright e2e (design §8.3): the human approves it like any
// proposal, and exploration starts after it merges.
function createSetupTicket({ title, spec }) {
  const id = nextTicketId();
  const tdir = ticketDir(id);
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, "proposal.md"), spec.trim());
  writeFileSync(join(tdir, "ticket.md"), proposalTicket({ title, spec, forbidden: [] }));
  createTicket({
    id,
    screen: loadScreens()[0].id,
    track: "propose",
    setup: true,
    status: "proposal",
    title,
    kind: "functional",
    severity: "medium",
    attempt: 0,
    base: null,
    candidate: null,
    branch: null,
    prTitle: "test: set up Playwright e2e",
    branchSlug: "e2e-setup",
    proposal: { version: 1, forbidden: [], note: "실행 지침 부트스트랩이 e2e가 없다고 판단함" },
    implement: { engine: "claude", model: settings().implementModel },
    review: { engine: "codex", model: settings().reviewModel },
    feedback: null,
    rejectReason: null,
    pr: null,
    createdAt: now(),
    updatedAt: now(),
  });
  return { result: "setup-ticket", ticket: id };
}

export async function exploreIteration() {
  await fetchOrigin();
  const tickets = listTickets();
  const recipeState = readRecipeState();
  if (recipeState.repair) return runRepair(recipeState.repair.reason);
  if (recipeState.stage === "failed" || recipeState.awaitingApproval?.length) {
    writeState({ ...readState(), idle: exploreBlocked(tickets, recipeState) });
    return { result: "idle", wait: IDLE_WAIT_MS };
  }
  if (setupTicketNeeded(tickets, recipeState)) return createSetupTicket(recipeState.e2eSetup);
  await cleanupBranches(tickets);
  const revising = tickets.find((t) => t.status === "revising");
  if (revising) {
    const task = revising.specApproved ? "제안 구현" : revising.reviseFrom === "proposal" ? "제안서 다시 쓰기" : "재구현";
    return work(task, revising, () => revise(revising));
  }
  const grouping = tickets.find((t) => t.status === "grouping");
  if (grouping) return work("묶음 구현", grouping, () => buildGroup(grouping));

  if (overApprovalCap(tickets)) {
    writeState({ ...readState(), idle: `승인 대기 티켓 ${MAX_APPROVAL_WAITING}개 이상` });
    return { result: "idle", wait: IDLE_WAIT_MS };
  }
  const mainSha = await gitOut(paths.repo, ["rev-parse", originBase()]);
  const health = await baseCheck(mainSha);
  if (!health.ok) {
    writeState({ ...readState(), mainBroken: health, idle: "main 검사 실패" });
    return { result: "main-broken", wait: IDLE_WAIT_MS };
  }
  writeState({ ...readState(), mainBroken: null, idle: null });
  const blocked = exploreBlocked(tickets, recipeState);
  if (blocked) {
    writeState({ ...readState(), idle: blocked });
    return { result: "idle", wait: IDLE_WAIT_MS };
  }
  const finding = nextOpenFinding(listFindings(), { proposals: proposalsToday(tickets) < PROPOSALS_PER_DAY });
  try {
    if (finding) {
      const task = finding.track === "propose" ? "제안 작성" : "결함 수정";
      setLane({ task, finding: finding.id, track: finding.track ?? "fix", screen: finding.area, title: `${finding.id} ${finding.title}`, since: now() });
      return await fixFinding(finding);
    }
    return await explore();
  } finally {
    setLane(null);
  }
}

// Idle waits end early when the human hands this lane work (a revise or PR feedback from Slack, the
// dashboard or the CLI). Error backoff keeps its full length so a failing ticket doesn't retry every
// 30 seconds.
const WAKES = { pr: ["pr-fixing"], explore: ["revising", "grouping"] };
const LANE_IDLE_MS = 30_000;

async function idleWait(ms) {
  const end = Date.now() + ms;
  const wakes = WAKES[currentLane().name];
  while (Date.now() < end) {
    await sleep(Math.min(LANE_IDLE_MS, end - Date.now()));
    if (listTickets().some((t) => wakes.includes(t.status))) return;
  }
}

async function runLane(lane, iterate) {
  return inLane(lane, async () => {
    let failures = 0;
    for (;;) {
      let wait = 0;
      let idle = false;
      try {
        const out = await iterate();
        if (out?.result !== "idle" || lane === LANES.explore) say(`[${lane.label}] ${JSON.stringify(out)}`);
        if (out && !["idle", "main-broken"].includes(out.result)) logRun(out);
        // watch alerts Slack on state.failures (3 in a row); a lane that recovers clears its own.
        if (failures) writeState({ ...readState(), failures: 0 });
        failures = 0;
        wait = out?.wait ?? 0;
        idle = wait > 0;
      } catch (e) {
        failures++;
        wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
        setLane(null);
        writeState({ ...readState(), failures, lastError: { at: now(), lane: lane.name, message: String(e.message ?? e).slice(0, 2000) } });
        logRun({ result: e instanceof EngineError ? "engine-error" : "error", lane: lane.name, error: String(e.message ?? e).slice(0, 4000) });
        say(`[${lane.label}] 오류 (${failures}회 연속), ${wait / 60000}분 뒤 재시도: ${e.message ?? e}`);
        await cleanWorktrees().catch(() => {});
      }
      if (wait) await (idle ? idleWait : sleep)(wait);
    }
  });
}

export async function loop() {
  const release = acquireLock(paths.lock);
  if (!release) {
    console.error("다른 루프가 이미 실행 중이다.");
    process.exit(1);
  }
  const killed = trackChildren(join(paths.run, "children.json")) + sweepOrphans();
  for (const lane of Object.values(LANES)) inLane(lane, stopDemo);
  await cleanWorktrees();
  reopenFixing();
  writeState({ ...readState(), lanes: {}, current: undefined, failures: 0 });
  say(`루프 시작: PR 줄과 탐색 줄을 함께 돌린다${killed ? ` (이전 실행이 남긴 프로세스 그룹 ${killed}개 정리)` : ""}`);
  await Promise.all([runLane(LANES.pr, prIteration), runLane(LANES.explore, exploreIteration)]);
}
