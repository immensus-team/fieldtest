// `fieldtest watch`, run every minute as the human user by a systemd timer. No AI here: it runs the human's
// Slack commands, reads PR state, hands review findings to the agent through files, pushes the
// agent's fixes and posts replies. The GitHub part runs every 5 minutes, or right after a command.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PR_ROUNDS, PR_CHECK_MS, paths } from "./config.mjs";
import { originBase, repoSlug } from "./recipe.mjs";
import { must, run } from "./exec.mjs";
import {
  behindMain,
  commentPr,
  editPrBody,
  failedLog,
  mergeCommit,
  prDiff,
  prView,
  replyToComment,
  replaceBlock,
  requiredChecks,
} from "./github.mjs";
import {
  addAssetCommits,
  assetShots,
  checkOnMain,
  clone,
  fetchMain,
  importBundle,
  ownCommits,
  mergeShots,
  redeployAsHuman,
  screenshotTable,
  shotsInBody,
  syncMirror,
  withScreenshots,
  withTempWorktree,
  writeTemp,
} from "./publish.mjs";
import { describeBroken, followMain, readAfterMerge, recordMerge } from "./aftermerge.mjs";
import { followRecipe } from "./bootstrap.mjs";
import { closeMembers, ticketScreen } from "./group.mjs";
import { approve } from "./human.mjs";
import { reviewOf } from "./review.mjs";
import { routeOf } from "./route.mjs";
import { slackCommands, slackNotice, slackTicketNotice, syncSlack } from "./slack.mjs";
import { outOfScope } from "./screens.mjs";
import { listTickets, readJson, readState, ticketDir, transition, writeJson } from "./store.mjs";
import { REPLIED_ONLY, autoFinal } from "./view.mjs";

const now = () => new Date().toISOString();
const vercelBlocked = (checks) => checks.optional.some((c) => c.name === "Vercel" && /blocked/i.test(c.description ?? ""));
const watchStateFile = () => join(paths.run, "watch-state.json");

async function closeOut(t, pr) {
  const status = pr.state === "MERGED" ? "merged" : "closed";
  await run("git", ["push", "--quiet", "origin", "--delete", t.pr.branch], { cwd: clone() });
  transition(t.id, t.status, { status });
  if (t.group) closeMembers(t, status);
  return status;
}

export async function checkReview(t) {
  const pr = await prView(t.pr.number);
  if (pr.state !== "OPEN") return closeOut(t, pr);
  const head = pr.headRefOid;
  const round = t.pr.round + 1;
  const request = (extra) => {
    const rdir = join(ticketDir(t.id), "pr-rounds", String(round));
    mkdirSync(rdir, { recursive: true });
    writeJson(join(rdir, "request.json"), { round, head, humanFeedback: null, findings: [], ciFailures: [], conflict: false, ...extra });
    transition(t.id, "pr-review", { status: "pr-fixing", pr: { ...t.pr, head } });
  };
  const toFinal = (note) => transition(t.id, "pr-review", { status: "final-review", finalNotified: false, prNote: note, pr: { ...t.pr, head } });

  if (pr.mergeable === "CONFLICTING") {
    if (t.pr.round >= MAX_PR_ROUNDS) return toFinal("main과 충돌함. 수정 라운드 상한에 닿아 자동 수정을 멈춤.");
    return request({ conflict: true });
  }
  const codex = await reviewOf(t, head);
  if (codex.failed) return toFinal(`서버 Codex 리뷰 실패: ${codex.failed.split("\n")[0]}`);
  const checks = await requiredChecks(t.pr.number);
  if (vercelBlocked(checks) && (await redeployAsHuman(t.pr.branch))) {
    transition(t.id, "pr-review", { pr: { ...t.pr, pushedAt: now() } });
    return "vercel-redeployed";
  }
  // A CI failure is fixed without waiting for the review of the same head.
  if (checks.pending || (!codex.done && !checks.failing.length)) return "waiting";
  if (!codex.findings.length && !checks.failing.length) return toFinal(null);
  const ciFailures = [];
  for (const c of checks.failing) ciFailures.push({ name: c.name, link: c.link, log: await failedLog(c) });
  if (t.pr.round >= MAX_PR_ROUNDS) {
    return toFinal(`수정 라운드 ${MAX_PR_ROUNDS}회 뒤에도 남은 것: Codex 지적 ${codex.findings.length}개, 실패한 check ${ciFailures.map((c) => c.name).join(", ") || "없음"}`);
  }
  return request({ findings: codex.findings, ciFailures });
}


async function pushRound(t) {
  const round = t.pr.round + 1;
  const rdir = join(ticketDir(t.id), "pr-rounds", String(round));
  const result = readJson(join(rdir, "result.json"), null);
  if (!result) throw new Error(`${t.id}: pr-rounds/${round}/result.json 없음`);
  const pr = await prView(t.pr.number);
  const stop = (note) => transition(t.id, "pr-push", { status: "final-review", finalNotified: false, prNote: note });
  if (pr.state !== "OPEN") return closeOut(t, pr);

  let head = pr.headRefOid;
  let prShots = t.pr.shots;
  if (result.head !== result.prHead) {
    await fetchMain(t.pr.branch);
    const fixed = await importBundle(join(rdir, "fix.bundle"), `pr/${t.id}`, `${t.id}-r${round}`);
    if (fixed !== result.head) return stop(`수정 bundle commit이 기록과 다름 (${fixed.slice(0, 7)})`);
    const ff = await run("git", ["merge-base", "--is-ancestor", pr.headRefOid, fixed], { cwd: clone() });
    if (ff.code !== 0) return stop("수정 commit이 현재 PR head 위에 있지 않음. push하지 않음.");
    const base = (await must("git", ["merge-base", originBase(), fixed], { cwd: clone() })).stdout.trim();
    const files = (await must("git", ["diff", "--name-only", base, fixed], { cwd: clone() })).stdout.split("\n").filter(Boolean);
    const outside = outOfScope(files, ticketScreen(t).paths);
    if (outside.length) return stop(`허용 범위 밖 파일이 바뀌어 push하지 않음: ${outside.join(", ")}`);

    const shotsDir = join(rdir, "shots");
    const shots = (result.shots ?? []).filter((f) => existsSync(join(shotsDir, f)));
    const pushed = await withTempWorktree(fixed, async (wt) => {
      await ownCommits(wt, pr.headRefOid);
      const asset = await addAssetCommits(wt, `${t.id}-r${round}`, shotsDir, shots);
      const r = await run("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${t.pr.branch}`], { cwd: wt });
      if (r.code !== 0) return { error: `push 거부: ${(r.stderr || r.stdout).trim().slice(0, 500)}` };
      const finalHead = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).stdout.trim();
      return { asset, finalHead };
    });
    if (pushed.error) return stop(`${pushed.error}. 다른 토큰이나 우회로 다시 시도하지 않음.`);
    head = pushed.finalHead;
    let body = pr.body;
    if (pushed.asset) {
      prShots = mergeShots(t.pr.shots ?? shotsInBody(pr.body), assetShots(pushed.asset, shots));
      body = withScreenshots(body, screenshotTable(prShots));
    }
    if (result.prBodyGaps?.length) {
      const old = body.match(/<!-- quality:gaps -->\n([\s\S]*?)\n<!-- \/quality:gaps -->/)?.[1] ?? "### 리뷰에서 드러난 기존 빈틈 (이 PR에서 고치지 않음)";
      body = replaceBlock(body, "gaps", `${old}\n${result.prBodyGaps.map((g) => `- ${g}`).join("\n")}`);
    }
    if (body !== pr.body) await editPrBody(t.pr.number, writeTemp("body.md", body));
  }

  const short = head.slice(0, 7);
  for (const c of result.comments ?? []) {
    const suffix = c.action === "fixed" ? `\n\n${short}에서 고침.` : "";
    await replyToComment(t.pr.number, c.commentId, `${c.reply}${suffix}`);
  }
  if (head === pr.headRefOid) {
    // Nothing pushed (every finding was accepted or disputed), so Codex will not review again.
    return transition(t.id, "pr-push", { status: "final-review", finalNotified: false, prNote: REPLIED_ONLY, pr: { ...t.pr, round } });
  }
  return transition(t.id, "pr-push", { status: "pr-review", pr: { ...t.pr, round, head, pushedAt: now(), shots: prShots } });
}

function roundSummary(t) {
  const dir = join(ticketDir(t.id), "pr-rounds");
  if (!existsSync(dir)) return "자동 수정 라운드 없음. 첫 Codex 리뷰와 CI가 깨끗함.";
  const label = { fixed: "수정", "accepted-risk": "수용한 위험", disagree: "반박" };
  return readdirSync(dir)
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => {
      const req = readJson(join(dir, n, "request.json"), {});
      const res = readJson(join(dir, n, "result.json"), null);
      const lines = [`**라운드 ${n}**`];
      if (req.humanFeedback) lines.push(`- 사람 피드백: ${req.humanFeedback}`);
      if (req.conflict) lines.push("- main 충돌 해결");
      for (const c of req.ciFailures ?? []) lines.push(`- CI 실패: ${c.name}`);
      for (const f of req.findings ?? []) {
        const done = res?.comments?.find((c) => c.commentId === f.id);
        lines.push(`- Codex \`${f.path}\`: ${done ? label[done.action] : "처리 안 됨"}`);
      }
      if (res?.summary) lines.push(`- 변경: ${res.summary}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// What a requested merge does next, from the PR state watch just read. A conflict, a CI failure or
// a Codex finding goes back to the PR fix rounds while any are left.
export function mergeStep({ mergeable, checks, codex, round }) {
  const fix = (reason) => (round < MAX_PR_ROUNDS ? { fix: reason } : { stop: `${reason}. 자동 수정 라운드 ${MAX_PR_ROUNDS}회를 다 씀` });
  if (mergeable === "CONFLICTING") return fix("main과 충돌함");
  if (checks.failing.length) return fix(`CI 실패 (${checks.failing.map((c) => c.name).join(", ")})`);
  if (checks.pending) return { wait: true };
  if (codex.done && codex.findings.length) return fix(`최신 commit에 리뷰 지적 ${codex.findings.length}개`);
  return { merge: true };
}

// A fix round that ended with a note (round limit, failed fix, refused push) stops the merge too.
// Its status note already tells the thread, so only the merge's own stops send a notice.
async function stopAutoMerge(t, reason, { notify = true } = {}) {
  transition(t.id, "final-review", { autoMerge: null, prNote: `자동 머지 멈춤: ${reason}` });
  if (notify) await slackTicketNotice(t.id, `⚠️ 자동 머지를 멈췄습니다.\n이유: ${reason}\n확인한 뒤 \`머지\`를 다시 누르거나 \`수정\`으로 고칠 점을 보내면 됩니다. merge하지 않고 닫으려면 \`거절\`을 보내면 됩니다.`);
  return "auto-merge-stopped";
}

// Progress, not a decision: it goes to the watch log, not Slack.
function fixRound(t, reason) {
  transition(t.id, "final-review", { status: "pr-review", finalNotified: false, prNote: null });
  console.log(`[${now()}] ${t.id} ${reason}. 자동으로 고칩니다 (수정 라운드 ${t.pr.round + 1}/${MAX_PR_ROUNDS}).`);
}

const setAutoMerge = (t, patch) => transition(t.id, "final-review", { autoMerge: { ...t.autoMerge, ...patch } });

// After the human pressed 머지: merge once the required checks pass. A PR behind main is not brought
// up to date and run through CI again (one merge per CI run when several wait); it is merged into
// the current main locally and merged when lint and typecheck pass on the result (checkOnMain), and
// aftermerge.mjs runs the browser suite on main afterwards. A conflict, CI failure or Codex finding
// goes through the PR fix rounds first. Nothing merges while main failed after an earlier merge.
async function autoMerge(t, pr) {
  const n = t.pr.number;
  const checks = await requiredChecks(n);
  if (vercelBlocked(checks) && (await redeployAsHuman(t.pr.branch))) return "vercel-redeployed";
  const step = mergeStep({
    mergeable: pr.mergeable,
    checks,
    codex: checks.pending ? { done: false, findings: [] } : await reviewOf(t, pr.headRefOid),
    round: t.pr.round,
  });
  if (step.stop) return stopAutoMerge(t, step.stop);
  if (step.wait) return "auto-merge-waiting";
  if (step.fix) {
    await fixRound(t, step.fix);
    return "auto-merge-fixing";
  }
  // A fix round may have grown the PR past the automatic route since it started merging.
  if (t.autoMerge.auto) {
    const route = routeOf(t, await prDiff(n));
    if (!route.auto) {
      transition(t.id, "final-review", { route: { ...t.route, ...route } });
      return stopAutoMerge(t, `자동 머지 기준을 벗어남 (${route.reasons.join(", ")})`);
    }
  }
  const broken = readAfterMerge().broken;
  if (broken) {
    if (t.autoMerge.held !== broken.at) setAutoMerge(t, { held: broken.at });
    return "auto-merge-held";
  }
  if (t.autoMerge.held) setAutoMerge(t, { held: null });
  const behind = (await behindMain(pr.headRefOid)) > 0;
  if (behind) {
    mkdirSync(join(paths.run, "merge-checks"), { recursive: true });
    const logFile = join(paths.run, "merge-checks", `${t.id}-${pr.headRefOid.slice(0, 7)}.log`);
    setAutoMerge(t, { held: null, checking: now() });
    const local = await checkOnMain(t.pr.branch, logFile);
    setAutoMerge(t, { held: null, checking: null });
    if (local.conflict) {
      if (t.pr.round >= MAX_PR_ROUNDS) return stopAutoMerge(t, `main과 충돌함. 자동 수정 라운드 ${MAX_PR_ROUNDS}회를 다 씀`);
      await fixRound(t, "main과 충돌함");
      return "auto-merge-fixing";
    }
    if (!local.ok) return stopAutoMerge(t, `최신 main과 합친 결과에서 ${local.failed.join(", ")} 실패 (로그: ${logFile})`);
  }
  const r = await run("gh", ["pr", "merge", String(n), "--repo", repoSlug(), "--squash", "--match-head-commit", pr.headRefOid]);
  if (r.code !== 0) return stopAutoMerge(t, `merge 거부: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  recordMerge({ ticket: t.id, pr: n, sha: await mergeCommit(n) });
  return closeOut(t, { state: "MERGED" });
}

function summaryBody(t, next) {
  return [
    "## 자동 처리 요약",
    "",
    roundSummary(t),
    "",
    t.prNote ? `**남은 문제:** ${t.prNote}` : "**남은 문제:** 없음. Codex 리뷰와 required check가 최신 head에서 깨끗함.",
    "",
    next,
  ].join("\n");
}

export async function finalize(t) {
  const pr = await prView(t.pr.number);
  if (pr.state !== "OPEN") return closeOut(t, pr);
  if (t.autoMerge) return t.prNote && t.prNote !== REPLIED_ONLY ? stopAutoMerge(t, t.prNote, { notify: false }) : autoMerge(t, pr);
  // A ticket on the automatic route merges without the human when the fix rounds left nothing and
  // its PR still meets the route. Otherwise it waits for the final review like any other.
  if (t.route?.auto) {
    const left = t.prNote && t.prNote !== REPLIED_ONLY;
    const route = left ? { auto: false, reasons: [`남은 문제: ${t.prNote}`] } : routeOf(t, await prDiff(t.pr.number));
    if (route.auto) {
      await commentPr(t.pr.number, writeTemp("summary.md", summaryBody(t, "자동 머지 기준(low·medium 기능 수정, 소스 3파일·80줄 이하, 화면 문구 변경 없음)을 충족해 사람 확인 없이 squash merge합니다.")));
      return autoMerge(transition(t.id, "final-review", { autoMerge: { at: now(), auto: true }, finalNotified: true }), pr);
    }
    t = transition(t.id, "final-review", { route: { ...t.route, ...route } });
  }
  // The final review changed nothing in the 28 tickets before 2026-10-23; the human's call is the
  // first approval. A clean PR merges on its own unless its severity is high.
  if (autoFinal(t)) {
    await commentPr(t.pr.number, writeTemp("summary.md", summaryBody(t, "남은 문제가 없고 심각도가 high가 아니라 최종 검토 없이 squash merge합니다.")));
    return autoMerge(transition(t.id, "final-review", { autoMerge: { at: now(), final: true }, finalNotified: true }), pr);
  }
  if (t.finalNotified) return "waiting-human";
  await commentPr(t.pr.number, writeTemp("summary.md", summaryBody(t, "최종 검토를 기다립니다. Slack 티켓 메시지의 `머지` 버튼으로 squash merge하거나, `수정` 버튼으로 고칠 점을 보내면 됩니다.")));
  transition(t.id, "final-review", { finalNotified: true });
  return "notified";
}

// Each awaiting candidate gets its route once. One ticket on the automatic route is approved per
// run, since approving waits up to 5 minutes for the draft CI run.
export async function autoApprove() {
  let next = null;
  for (const t of listTickets()) {
    if (t.status !== "awaiting") continue;
    let route = t.route;
    if (route?.attempt !== t.attempt) {
      const patch = readFileSync(join(ticketDir(t.id), "attempts", String(t.attempt), "diff.patch"), "utf8");
      route = { ...routeOf(t, patch), attempt: t.attempt };
      transition(t.id, "awaiting", { route });
    }
    if (route.auto && !next) next = t.id;
  }
  if (!next) return null;
  try {
    return await approve(next);
  } catch (e) {
    throw new Error(`${next} 자동 진행 실패: ${e.message}`);
  }
}

// Enough of a log to show what led up to a failure.
const LOG_TAIL_BYTES = 64 * 1024;

function tailFile(file) {
  if (!existsSync(file)) return `(${file} 없음)`;
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return len < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

// Error alerts go to the Slack DM with the log in the thread. The log is kept in run/errors/ first,
// so a post that fails (often the same network outage) is retried on the next run with the same log.
async function alert(text, { name, log }) {
  const dir = join(paths.run, "errors");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name.replace(/[^\w-]/g, "-")}.log`);
  if (!existsSync(file)) writeFileSync(file, log);
  try {
    await slackNotice(`${text}\n로그: ${file}`, { log: readFileSync(file, "utf8") });
    return true;
  } catch (e) {
    console.error(`[${now()}] slack 알림 실패: ${e.message}`);
    return false;
  }
}

export async function mainHealth() {
  const state = readState();
  const ws = readJson(watchStateFile(), {});
  const sha = state.mainBroken?.sha ?? null;
  if (sha && ws.mainBrokenNotified !== sha) {
    const sent = await alert(`main ${sha.slice(0, 7)} 검사 실패 (${state.mainBroken.failed.join(", ")}). 새 탐색을 멈췄습니다.`, {
      name: `main-${sha.slice(0, 12)}`,
      log: `main ${sha} 검사 로그 마지막 부분\n\n${tailFile(join(paths.baseChecks, `${sha}.log`))}`,
    });
    if (sent) ws.mainBrokenNotified = sha;
  }
  if (state.failures >= 3 && ws.failuresNotified !== state.lastError?.at) {
    const sent = await alert(`에이전트 루프 오류 ${state.failures}회 연속: ${state.lastError?.message?.split("\n")[0] ?? ""}`, {
      name: `loop-${state.lastError?.at}`,
      log: `${state.lastError?.at} 에이전트 루프 오류 ${state.failures}회 연속. loop.log 마지막 부분\n\n${tailFile(join(paths.run, "loop.log"))}`,
    });
    if (sent) ws.failuresNotified = state.lastError?.at;
  }
  mkdirSync(paths.run, { recursive: true });
  writeJson(watchStateFile(), ws);
}

export async function watch() {
  // A run with several merges takes minutes; the dashboard shows it as running from this time.
  writeJson(watchStateFile(), { ...readJson(watchStateFile(), {}), startedAt: now() });
  await mainHealth();
  let commands = 0;
  try {
    commands = await slackCommands();
  } catch (e) {
    console.error(`[${now()}] slack 명령 확인 실패: ${e.message}`);
  }
  try {
    const approved = await autoApprove();
    if (approved) {
      console.log(`[${now()}] 자동 진행 ${approved}`);
      commands++;
    }
  } catch (e) {
    console.error(`[${now()}] ${e.message}`);
  }
  const ws = readJson(watchStateFile(), {});
  // A requested merge, or a PR on the automatic route that reached the end, is followed every minute;
  // other PR state every PR_CHECK_MS.
  const merging = listTickets().some((t) => t.autoMerge || autoFinal(t));
  if (commands || merging || !ws.prCheckedAt || Date.now() - Date.parse(ws.prCheckedAt) >= PR_CHECK_MS) {
    await checkPrs();
    writeJson(watchStateFile(), { ...readJson(watchStateFile(), {}), prCheckedAt: now() });
  }
  try {
    const s = await followMain({ notify: alert });
    if (s.broken && s.broken.at !== ws.brokenLogged) {
      console.log(`[${now()}] ${describeBroken(s.broken)}`);
      writeJson(watchStateFile(), { ...readJson(watchStateFile(), {}), brokenLogged: s.broken.at });
    }
  } catch (e) {
    console.error(`[${now()}] 머지 후 main 확인 실패: ${e.message}`);
  }
  try {
    await followRecipe({ notify: (text) => slackNotice(text) });
  } catch (e) {
    console.error(`[${now()}] 실행 지침 확인 실패: ${e.message}`);
  }
  try {
    const n = await syncSlack(listTickets());
    if (n.created || n.noted) console.log(`[${now()}] slack: 새 메시지 ${n.created}, 상태 알림 ${n.noted}`);
  } catch (e) {
    console.error(`[${now()}] slack 동기화 실패: ${e.message}`);
  }
  // A quiet pass logs nothing, so the dashboard reads this to tell a live watch from a stuck one.
  writeJson(watchStateFile(), { ...readJson(watchStateFile(), {}), ranAt: now() });
}

async function checkPrs() {
  await syncMirror();
  const handlers = { "pr-review": checkReview, "pr-push": pushRound, "final-review": finalize };
  for (const t of listTickets()) {
    const handle = handlers[t.status];
    if (!handle) continue;
    try {
      const out = await handle(t);
      console.log(`[${now()}] ${t.id} ${t.status}: ${typeof out === "string" ? out : (out?.status ?? "ok")}`);
    } catch (e) {
      console.error(`[${now()}] ${t.id} ${t.status} 실패: ${e.message}`);
    }
  }
  // Pushes made above reach the agent through the mirror.
  await syncMirror();
}
