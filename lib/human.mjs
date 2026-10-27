// Commands the human runs: status, list, show, approve, reject, revise, feedback. The decision
// commands return their result line; the CLI prints it and Slack replies with it.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_APPROVAL_WAITING, paths } from "./config.mjs";
import { originBase } from "./recipe.mjs";
import { reviewOf } from "./review.mjs";
import { LANES } from "./lane.mjs";
import { must, run } from "./exec.mjs";
import { behindMain, closePr, createDraftPr, markReady, mergeCommit, mergeSquash, openPrsWithFiles, prListByHead, prView, requiredChecks, waitDraftCi } from "./github.mjs";
import {
  clone,
  fetchMain,
  importBundle,
  ownCommits,
  syncMirror,
  assetShots,
  screenshotTable,
  withGateResult,
  withReviewResult,
  withScreenshots,
  withTempWorktree,
  writeTemp,
} from "./publish.mjs";
import { describeBroken, readAfterMerge, recordMerge } from "./aftermerge.mjs";
import { mergeStep } from "./watch.mjs";
import { releaseMembers } from "./group.mjs";
import { listFindings } from "./findings.mjs";
import { approvalWaiting, listTickets, readJson, readState, readTicket, recentRuns, ticketDir, transition, writeJson } from "./store.mjs";

function need(id) {
  const t = readTicket(id);
  if (!t) throw new Error(`${id}: 티켓이 없습니다`);
  return t;
}

function shotsIn(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^(before|after)-.+\.png$/.test(f)).sort() : [];
}

export async function status() {
  const tickets = listTickets();
  const state = readState();
  const lock = readJson(paths.lock, null);
  const counts = {};
  for (const t of tickets) counts[t.status] = (counts[t.status] ?? 0) + 1;
  console.log(`승인 대기: ${approvalWaiting(tickets)}/${MAX_APPROVAL_WAITING} (최종 검토 ${counts["final-review"] ?? 0}개는 세지 않음)  ${JSON.stringify(counts)}`);
  const judge = tickets.filter((t) => t.status === "needs-human");
  if (judge.length) console.log(`판단 필요: ${judge.map((t) => t.id).join(", ")}  (fieldtest show로 사유 확인, revise나 reject로 처리)`);
  console.log(`루프: ${lock ? `pid ${lock}` : "lock 없음"}`);
  for (const lane of Object.values(LANES)) {
    const cur = state.lanes?.[lane.name];
    console.log(`- ${lane.label} 줄: ${cur ? `${cur.task} ${cur.ticket ?? cur.title ?? cur.screen} (${cur.since})` : "대기"}`);
  }
  const open = listFindings().filter((f) => f.status === "open");
  if (open.length) console.log(`고치기 전인 발견: ${open.map((f) => f.id).join(", ")}`);
  if (state.idle) console.log(`탐색 대기 이유: ${state.idle}`);
  if (state.mainBroken) console.log(`main 검사 실패: ${state.mainBroken.sha.slice(0, 7)} ${state.mainBroken.failed.join(", ")}`);
  if (state.lastError) console.log(`마지막 오류: ${state.lastError.at} ${state.lastError.message?.split("\n")[0]}`);
  console.log("\n최근 실행:");
  for (const r of recentRuns(8)) console.log(`- ${r.at} ${r.finding ?? r.screen ?? r.ticket ?? r.goal ?? ""} ${r.result}${r.ticket ? ` ${r.ticket}` : ""}${r.reason ? `: ${r.reason.split("\n")[0]}` : ""}${r.error ? `: ${r.error.split("\n")[0]}` : ""}`);
}

export function list() {
  for (const t of listTickets()) {
    const pr = t.pr ? ` PR #${t.pr.number} r${t.pr.round}` : "";
    const why = t.status === "needs-human" ? `  [판단 필요] ${t.needsHumanReason?.split("\n")[0] ?? ""}` : "";
    console.log(`${t.id}  ${t.status.padEnd(12)} ${t.screen.padEnd(11)} ${t.title}${pr}${why}`);
  }
}

export async function show(id, { open = false } = {}) {
  const t = need(id);
  const dir = ticketDir(id);
  const adir = join(dir, "attempts", String(t.attempt));
  console.log(readFileSync(join(dir, "ticket.md"), "utf8"));
  console.log(`\n상태: ${t.status}  attempt ${t.attempt}  구현 ${t.implement.engine}${t.implement.model ? `(${t.implement.model})` : ""}`);
  if (t.pr) console.log(`PR: ${t.pr.url} (round ${t.pr.round})`);
  if (t.status === "needs-human") {
    console.log(`판단 필요: ${t.needsHumanReason}`);
    console.log("승인할 후보가 없다. 방향을 주려면 fieldtest revise, 닫으려면 fieldtest reject를 쓴다.");
  }
  if (t.prNote) console.log(`메모: ${t.prNote}`);
  const shots = shotsIn(join(adir, "shots"));
  console.log(`\n스크린샷 (${join(adir, "shots")}):\n${shots.map((s) => `- ${s}`).join("\n") || "- 없음"}`);
  const files = readJson(join(adir, "files.json"), []);
  try {
    const overlap = (await openPrsWithFiles())
      .map((p) => ({ ...p, same: p.files.map((f) => f.path).filter((f) => files.includes(f)) }))
      .filter((p) => p.same.length && p.number !== t.pr?.number);
    console.log("\n같은 파일을 바꾸는 열린 PR:");
    console.log(overlap.map((p) => `- #${p.number} ${p.title}\n  ${p.same.join(", ")}`).join("\n") || "- 없음");
  } catch (e) {
    console.log(`\n열린 PR을 조회하지 못했다: ${e.message.split("\n")[0]}`);
  }
  if (open && shots.length) await run("open", shots.map((s) => join(adir, "shots", s)));
}

// A final-review ticket's PR is closed without merging first, so the ticket never ends with its PR open.
export async function reject(id, reason) {
  if (!reason) throw new Error("--reason이 필요합니다");
  const from = need(id);
  let closed = "";
  if (from.status === "final-review") {
    const pr = await prView(from.pr.number);
    if (pr.state === "MERGED") throw new Error(`${id}: 이미 merge된 PR입니다 (PR #${pr.number}).`);
    if (pr.state === "OPEN") await closePr(pr.number, `리뷰어가 거절해 merge하지 않고 닫습니다. 이유: ${reason}`);
    closed = `PR #${pr.number}을 merge하지 않고 닫고 `;
  }
  const t = transition(id, ["awaiting", "needs-human", "proposal", "final-review"], { status: "rejected", rejectReason: reason, autoMerge: null });
  if (!t.group) return `${id}: ${closed}거절했습니다.`;
  // The tickets it took over go back to the human one by one.
  releaseMembers(t);
  return `${id}: 묶음을 거절했습니다. 묶었던 티켓 ${t.group.members.join(", ")}은 각자 승인 대기로 돌아갑니다.`;
}

export function revise(id, feedback, { engine, model } = {}) {
  if (!feedback) throw new Error("--feedback이 필요합니다");
  const t = need(id);
  const nextEngine = engine ?? t.implement.engine;
  if (!["claude", "codex"].includes(nextEngine)) throw new Error("--engine은 claude 또는 codex만 쓸 수 있습니다");
  const nextModel = model ?? (engine && engine !== t.implement.engine ? null : t.implement.model);
  transition(id, ["awaiting", "needs-human", "proposal"], {
    status: "revising",
    specApproved: false,
    reviseFrom: t.status,
    feedback,
    // The human wants to see what their direction led to, so the ticket leaves the automatic route.
    humanTouched: true,
    implement: { engine: nextEngine, model: nextModel },
  });
  return `${id}: 재구현을 요청했습니다 (${nextEngine}${nextModel ? ` ${nextModel}` : ""}). 에이전트가 곧 시작합니다.`;
}

export function feedback(id, text) {
  if (!text) throw new Error("--feedback이 필요합니다");
  const t = need(id);
  if (t.status !== "final-review") throw new Error(`${id}: 최종 검토 중인 PR에만 쓸 수 있습니다 (현재 ${t.status})`);
  const round = t.pr.round + 1;
  const rdir = join(ticketDir(id), "pr-rounds", String(round));
  mkdirSync(rdir, { recursive: true });
  writeJson(join(rdir, "request.json"), { round, head: t.pr.head, humanFeedback: text, findings: [], ciFailures: [], conflict: false });
  // The human wants to see the result, so a merge they asked for earlier waits for them again.
  transition(id, "final-review", { status: "pr-fixing", finalNotified: false, prNote: null, autoMerge: null, humanTouched: true });
  return `${id}: PR 수정을 요청했습니다 (라운드 ${round}). 에이전트가 곧 시작합니다.`;
}

// Runs when the human presses 머지 (or `fieldtest merge`). A clean, up-to-date PR is merged now while
// main is healthy. Otherwise watch merges it once CI passes (watch.mjs autoMerge): a PR behind main
// is checked against the current main locally instead of being brought up to date and run through
// CI again. A conflict, CI failure or Codex finding goes through the PR fix rounds first; anything
// else, or no rounds left, stops it and tells the ticket thread.
export async function merge(id) {
  const t = need(id);
  if (t.status !== "final-review") throw new Error(`${id}: 최종 검토 중인 PR만 merge할 수 있습니다 (현재 ${t.status})`);
  const n = t.pr.number;
  const pr = await prView(n);
  if (pr.state === "MERGED") return `${id}: 이미 merge된 PR입니다 (PR #${n}).`;
  if (pr.state !== "OPEN") throw new Error(`${id}: 닫힌 PR입니다 (PR #${n}).`);
  if (t.autoMerge) return `${id}: 이미 자동 머지를 진행 중입니다.`;
  const checks = await requiredChecks(n);
  const codex = await reviewOf(t, pr.headRefOid);
  const step = mergeStep({ mergeable: pr.mergeable, checks, codex, round: t.pr.round });
  if (step.stop) throw new Error(`${id}: ${step.stop}`);
  const autoMerge = { at: new Date().toISOString() };
  if (step.fix) {
    transition(id, "final-review", { status: "pr-review", autoMerge, finalNotified: false, prNote: null });
    return `${id}: ${step.fix}. 자동으로 고친 뒤 CI와 Codex 리뷰를 통과하면 squash merge합니다. 오류가 나면 멈추고 알립니다.`;
  }
  const broken = readAfterMerge().broken;
  if (!broken && !checks.pending && (await behindMain(pr.headRefOid)) === 0) {
    await mergeSquash(n, pr.headRefOid);
    recordMerge({ ticket: id, pr: n, sha: await mergeCommit(n) });
    return `${id}: PR #${n} squash merge를 마쳤습니다.`;
  }
  // The human chose to merge despite the note; a note left in place would stop the merge at once.
  transition(id, "final-review", { autoMerge, prNote: null });
  if (broken) return `${id}: ${describeBroken(broken)}. main이 다시 통과하면 자동으로 squash merge합니다.`;
  return `${id}: CI가 통과하면 최신 main과 합쳐 lint·typecheck를 확인한 뒤 자동으로 squash merge합니다. 오류가 나면 멈추고 알립니다.`;
}

// A ticket fixed by another PR (several tickets of one cause fixed together). Only after that PR
// merged; the ticket's own PR must already be closed.
const RESOLVABLE = ["awaiting", "needs-human", "final-review", "closed"];

export async function resolve(id, number) {
  if (!Number.isInteger(number) || number <= 0) throw new Error("--pr <번호>가 필요합니다");
  const t = need(id);
  if (!RESOLVABLE.includes(t.status)) throw new Error(`${id}: ${t.status} 상태에서는 종료할 수 없습니다`);
  const pr = await prView(number);
  if (pr.state !== "MERGED") throw new Error(`${id}: PR #${number}이 아직 merge되지 않았습니다`);
  if (t.pr && (await prView(t.pr.number)).state === "OPEN") throw new Error(`${id}: 티켓의 PR #${t.pr.number}을 먼저 닫아야 합니다`);
  transition(id, RESOLVABLE, { status: "merged", resolvedBy: { number, url: pr.url }, autoMerge: null });
  return `${id}: PR #${number}로 해결 완료 처리했습니다.`;
}

// An approved spec goes to the loop to be built. A spec whose plan needs paths the agent may not change
// is the human's to build (design §8.7).
function approveProposal(t) {
  const forbidden = t.proposal?.forbidden ?? [];
  if (forbidden.length) {
    transition(t.id, "proposal", { status: "needs-human", needsHumanReason: `승인한 제안이 에이전트가 바꿀 수 없는 경로(${forbidden.join(", ")})를 건드려 사람이 구현해야 합니다. 제안서는 티켓 본문에 있습니다.` });
    return `${t.id}: 제안을 승인했습니다. 금지 경로가 필요해 사람이 구현하도록 판단 필요로 옮겼습니다.`;
  }
  transition(t.id, "proposal", { status: "revising", reviseFrom: "proposal", specApproved: true, feedback: "승인된 제안서대로 구현한다.", reviseNote: null });
  return `${t.id}: 제안을 승인했습니다. 에이전트가 제안서대로 구현해 후보를 만들면 다시 승인을 요청합니다.`;
}

export async function approve(id) {
  const t = need(id);
  if (t.status === "proposal") return approveProposal(t);
  if (t.status === "needs-human") throw new Error(`${id}: 판단 필요 티켓에는 승인할 후보가 없습니다. revise로 방향을 주거나 reject하면 됩니다.`);
  if (t.status !== "awaiting") throw new Error(`${id}: 승인 대기 상태가 아닙니다 (현재 ${t.status})`);
  const adir = join(ticketDir(id), "attempts", String(t.attempt));
  await fetchMain();
  const sha = await importBundle(join(adir, "candidate.bundle"), t.branch, id);
  if (sha !== t.candidate) throw new Error(`${id}: bundle commit ${sha}이 티켓 기록 ${t.candidate}과 다름`);

  const merge = await run("git", ["merge-tree", "--write-tree", originBase(), sha], { cwd: clone() });
  if (merge.code === 1) {
    transition(id, "awaiting", {
      status: "revising",
      rebase: true,
      feedback: "최신 main과 충돌한다. 최신 main 기준으로 같은 결함을 다시 고친다. 방향은 이전 시도와 같아도 된다.",
    });
    return `${id}: 최신 main과 충돌해 재구현을 요청했습니다. PR은 만들지 않았습니다.`;
  }
  if (merge.code !== 0) throw new Error(`merge-tree 실패: ${merge.stderr}`);

  const branch = `fix/${id.toLowerCase()}-${(t.branchSlug || "qa").replace(/[^a-z0-9-]/g, "").slice(0, 40)}`;
  const existing = (await prListByHead(branch)).find((p) => p.state === "OPEN");
  if (existing) {
    transition(id, "awaiting", { status: "pr-review", pr: { number: existing.number, url: existing.url, branch, head: existing.headRefOid, round: 0, pushedAt: new Date().toISOString() } });
    return `${id}: 이미 열린 PR을 연결했습니다. ${existing.url}`;
  }

  const shotsDir = join(adir, "shots");
  const shots = shotsIn(shotsDir);
  const gates = readdirSync(adir).filter((f) => /^gate-\d+\.json$/.test(f)).sort();
  const gate = gates.length ? readJson(join(adir, gates.at(-1)), null) : null;
  const body = withReviewResult(withGateResult(readFileSync(join(adir, "pr-body.md"), "utf8"), gate?.ok ? gate : null), readJson(join(adir, "review.json"), null));
  let prShots = [];
  const pr = await withTempWorktree(sha, async (wt) => {
    const git = (args) => must("git", args, { cwd: wt });
    await ownCommits(wt, (await git(["merge-base", originBase(), sha])).stdout.trim());
    let asset = null;
    if (shots.length) {
      // Push the asset commit alone first so the draft PR's image links resolve.
      const rel = `docs/pr-assets/${id.toLowerCase()}`;
      await must("mkdir", ["-p", join(wt, rel)]);
      for (const f of shots) await must("cp", [join(shotsDir, f), join(wt, rel, f)]);
      await git(["add", "-f", rel]);
      await git(["commit", "--quiet", "--no-verify", "-m", `chore: add ${id} review screenshots`]);
      asset = { assetSha: (await git(["rev-parse", "HEAD"])).stdout.trim(), rel };
    }
    await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    prShots = assetShots(asset, shots);
    const bodyFile = writeTemp("body.md", withScreenshots(body, screenshotTable(prShots)));
    const created = await createDraftPr({ branch, title: t.prTitle, bodyFile });
    if (asset) {
      await git(["rm", "-r", "--cached", "--quiet", "docs/pr-assets"]);
      await git(["commit", "--quiet", "--no-verify", "-m", `chore: stop tracking ${id} review screenshots`]);
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    }
    const same = await run("git", ["diff", "--quiet", sha, "HEAD"], { cwd: wt });
    if (same.code !== 0) throw new Error(`${id}: 최종 tree가 승인한 commit과 다름. PR ${created.url}은 Draft로 남김.`);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await waitDraftCi(head);
    await markReady(created.number);
    return { ...created, head };
  });
  transition(id, "awaiting", { status: "pr-review", pr: { number: pr.number, url: pr.url, branch, head: pr.head, round: 0, pushedAt: new Date().toISOString(), shots: prShots } });
  await syncMirror();
  return `${id}: Ready PR을 만들었습니다. CI와 Codex 리뷰를 진행합니다. ${pr.url}`;
}

