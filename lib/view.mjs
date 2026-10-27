// What the dashboard (lib/web.mjs) and Slack show for a ticket: its board column, stage, the reason it
// stopped, its progress steps and the buttons the human may press. Pure functions over the ticket, its
// log lines and live signals, so the rules are tested once and shared.

const TERMINAL = ["merged", "rejected", "closed"];

const STEPS = [
  ["found", "발견"],
  ["implement", "구현"],
  ["gate", "검사"],
  ["review", "리뷰"],
  ["approve", "승인"],
  ["pr", "PR"],
  ["checks", "CI·Codex"],
  ["final", "최종 검토"],
  ["merge", "머지"],
];

const COLUMNS = {
  awaiting: "awaiting",
  "needs-human": "awaiting",
  proposal: "awaiting",
  revising: "working",
  grouping: "working",
  grouped: "working",
  "pr-review": "working",
  "pr-fixing": "working",
  "pr-push": "working",
  "final-review": "final",
  merged: "done",
  rejected: "done",
  closed: "done",
};

// prNote when a PR fix round only answered the findings: nothing is wrong with the PR.
export const REPLIED_ONLY = "코드 변경 없이 답글로 처리함.";
const realNote = (t) => Boolean(t.prNote) && t.prNote !== REPLIED_ONLY;
// A clean final-review PR that watch merges on its next pass: on the automatic route, or any ticket
// whose severity is not high (2026-10-23). High severity keeps the human's final review.
export const autoFinal = (t) => t.status === "final-review" && (Boolean(t.route?.auto) || t.severity !== "high") && !realNote(t);

// A failure repeated this many times in a row in the logs is shown as one.
export const REPEAT_MIN = 3;

export function buttonsFor(t) {
  const adopt = t.reviseAdvice ? ["adopt"] : [];
  if (t.status === "awaiting") return ["approve", "reject", "revise", ...adopt];
  if (t.status === "needs-human") return ["reject", "revise", ...adopt];
  if (t.status === "proposal") return ["approve", "reject", "revise"];
  // A clean PR on the automatic route has nothing to decide until watch takes it off the route.
  if (t.status === "final-review") return t.autoMerge || autoFinal(t) ? [] : ["merge", "revise", "reject"];
  return [];
}

// The dashboard names 수정 on a final-review PR "feedback": it goes to the PR, not a new candidate.
export function actionsOf(t) {
  return buttonsFor(t).map((k) => (k === "revise" && t.status === "final-review" ? "feedback" : k));
}

export const columnOf = (t) => COLUMNS[t.status] ?? "working";

export function stageOf(t) {
  switch (t.status) {
    case "awaiting":
      return t.route?.auto ? "자동 진행 대기" : "승인 대기";
    case "needs-human":
      return "판단 필요";
    case "proposal":
      return "제안 승인 대기";
    case "revising":
      return t.specApproved ? "제안 구현" : t.reviseFrom === "proposal" ? "제안서 다시 쓰기" : "재구현";
    case "grouping":
      return "묶음 구현";
    case "grouped":
      return `묶음 처리 중 (${t.groupId})`;
    case "pr-review":
      return "CI·Codex 리뷰 대기";
    case "pr-fixing":
      return `PR 수정 라운드 ${(t.pr?.round ?? 0) + 1}`;
    case "pr-push":
      return "수정 push 대기";
    case "final-review":
      return t.autoMerge || autoFinal(t) ? "자동 머지 중" : "최종 검토";
    case "merged":
      return t.resolvedBy ? `PR #${t.resolvedBy.number}에서 해결` : "머지됨";
    case "rejected":
      return "거절됨";
    case "closed":
      return "PR 닫힘";
    default:
      return t.status;
  }
}

export function failureSummary(reason) {
  const lines = String(reason ?? "").split("\n");
  const items = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  return items.length ? `${lines[0].trim()}: ${items.slice(0, 3).join(" / ")}` : lines[0].trim();
}

// "[2026-10-19T05:53:51.937Z] text" → { at, text }; lines without a time keep at null.
export function parseLine(line) {
  const m = line.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] ?(.*)$/);
  return m ? { at: m[1], text: m[2] } : { at: null, text: line };
}

// What a command led to, read from the ticket's log lines ({ at, text }, oldest first) between the
// command and the next command for the same ticket. Null while it is still running.
const LOOP_OUTCOMES = {
  revised: () => ({ ok: true, text: "재구현 끝남. 새 후보가 승인 대기" }),
  "revise-blocked": (r) => ({ ok: false, text: `재구현 실패: ${r.reason ?? ""}` }),
  "pr-fixed": (r) => ({ ok: true, text: `PR 수정 라운드 ${r.round ?? ""} 끝남. watch가 push` }),
  "pr-fix-failed": (r) => ({ ok: false, text: `PR 수정 실패: ${r.reason ?? ""}` }),
};
const WATCH_OUTCOMES = {
  merged: { ok: true, text: "머지됨" },
  closed: { ok: false, text: "PR이 닫힘" },
  "auto-merge-stopped": { ok: false, text: "자동 머지 멈춤. 남은 문제를 확인" },
};

export function outcomeOf(command, lines, until = null) {
  if (command.ok !== true) return null;
  const want = { 수정: ["loop"], 머지: ["watch"] }[command.verb];
  if (!want) return null;
  for (const l of lines) {
    if (!l.at || l.at <= command.at || (until && l.at >= until)) continue;
    if (want.includes("loop") && l.text.includes('{"result"')) {
      let r;
      try {
        r = JSON.parse(l.text.slice(l.text.indexOf("{")));
      } catch {
        continue;
      }
      if (r.ticket === command.id && LOOP_OUTCOMES[r.result]) return { at: l.at, ...LOOP_OUTCOMES[r.result](r) };
    }
    if (want.includes("watch")) {
      const m = l.text.match(/^(QA-\d{4}) [a-z-]+: ([a-z-]+)$/);
      if (m && m[1] === command.id && WATCH_OUTCOMES[m[2]]) return { at: l.at, ...WATCH_OUTCOMES[m[2]] };
    }
  }
  return null;
}

// The same failure at the end of a ticket's log lines, counted. Lines are { at, text }, oldest first.
export function repeatedFailure(lines, id) {
  const fails = lines.filter((l) => l.text.includes(id) && /실패/.test(l.text));
  if (!fails.length) return null;
  const last = fails.at(-1);
  // Only failures that are still happening: nothing but the same failure since it began.
  const mine = lines.filter((l) => l.text.startsWith(`${id} `) || l.text.startsWith(`${id}:`));
  let count = 0;
  for (let i = mine.length - 1; i >= 0 && mine[i].text === last.text; i--) count++;
  return count >= REPEAT_MIN ? { count, last: last.at, text: last.text.replace(`${id} `, "") } : null;
}

export function blockedOf(t, lines = []) {
  const repeat = TERMINAL.includes(t.status) ? null : repeatedFailure(lines, t.id);
  let text = null;
  let tone = "warn";
  if (t.reviseNote && ["awaiting", "needs-human", "proposal"].includes(t.status)) {
    text = `재구현 실패: ${failureSummary(t.reviseNote)}`;
    tone = "error";
  } else if (t.status === "needs-human") {
    text = t.needsHumanReason ?? "판단이 필요합니다";
    tone = "error";
  } else if (t.status === "final-review" && t.prNote === REPLIED_ONLY) {
    text = "Codex 지적에 코드 변경 없이 답글로 대응함";
  } else if (t.status === "final-review" && t.prNote) {
    text = t.prNote;
    tone = /실패|멈춤|거부|필요/.test(t.prNote) ? "error" : "warn";
  } else if (t.status === "rejected" && t.rejectReason) {
    text = `거절: ${t.rejectReason}`;
  }
  if (repeat) {
    return { text: text ?? repeat.text, tone: "error", repeat: { count: repeat.count, last: repeat.last } };
  }
  return text ? { text, tone, repeat: null } : null;
}

// Where the loop is in its current work, from its last progress line and the files of the run.
// line: the last loop line for the work; files: names in the run directory.
export function liveStep(task, line, files = []) {
  const has = (f) => files.includes(f);
  if (task === "카드 작성") return { step: "review", detail: "요약 카드 작성 중" };
  if (task === "원인 분류") return { step: "review", detail: "원인 분류 중" };
  if (task === "제안서 다시 쓰기") return { step: "found", detail: "제안서 다시 쓰는 중" };
  const pr = line?.match(/PR 수정 라운드 (\d+), 세션 (\d+)\/(\d+)/);
  if (pr) {
    const [, round, n, max] = pr;
    if (has(`fix-${n}.json`) && !has(`gate-${n}.json`)) return { step: "checks", detail: `PR 수정 라운드 ${round} · 검사 중` };
    return { step: "checks", detail: `PR 수정 라운드 ${round} · 세션 ${n}/${max}` };
  }
  if (line && /검토 세션/.test(line)) return { step: "review", detail: "Codex 검토 중" };
  const impl = line?.match(/구현 세션 (\d+)\/(\d+)/);
  if (impl) {
    const [, n, max] = impl;
    if (has(`implement-${n}.json`) && !has(`gate-${n}.json`)) return { step: "gate", detail: `검사 중 (세션 ${n}/${max})` };
    return { step: "implement", detail: `구현 세션 ${n}/${max}` };
  }
  return { step: task === "PR 수정" ? "checks" : "implement", detail: task ? `${task} 준비 중` : null };
}

const PASS = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAIL = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"];

// statusCheckRollup entries (CheckRun or StatusContext) → { name, state, bucket }.
export function checkOf(c) {
  const name = c.name ?? c.context;
  if (c.__typename === "StatusContext" || c.context) {
    const s = c.state;
    return { name, state: s, bucket: s === "SUCCESS" ? "pass" : FAIL.includes(s) ? "fail" : "pending", link: c.targetUrl };
  }
  if (c.status !== "COMPLETED") return { name, state: c.status, bucket: "pending", link: c.detailsUrl };
  return { name, state: c.conclusion, bucket: PASS.includes(c.conclusion) ? "pass" : "fail", link: c.detailsUrl };
}

// Passed/total over the required checks (all reported checks when no rule names them).
// A required check not reported yet counts as not passed.
export function checksSummary(rollup = [], required = []) {
  const checks = rollup.map(checkOf);
  const byName = new Map(checks.map((c) => [c.name, c]));
  const relevant = required.length ? required.map((n) => byName.get(n) ?? { name: n, state: "EXPECTED", bucket: "pending" }) : checks;
  return {
    checks,
    passed: relevant.filter((c) => c.bucket === "pass").length,
    total: relevant.length,
    failing: relevant.filter((c) => c.bucket === "fail").length,
    pending: relevant.filter((c) => c.bucket === "pending").length,
  };
}

const CODEX_TEXT = { pending: "Codex 대기", clean: "Codex 통과", findings: "Codex 지적" };

function checksDetail(pr) {
  if (!pr) return { detail: null, ratio: null };
  const parts = [];
  if (pr.total) parts.push(pr.failing ? `CI 실패 ${pr.failing}` : `CI ${pr.passed}/${pr.total} 통과`);
  if (pr.codex) parts.push(pr.codex === "findings" ? `${CODEX_TEXT.findings} ${pr.findings}건` : CODEX_TEXT[pr.codex]);
  return { detail: parts.join(" · ") || null, ratio: pr.total ? pr.passed / pr.total : null };
}

// Which step a status sits on, before live signals refine it.
function baseStep(t) {
  switch (t.status) {
    case "awaiting":
    case "needs-human":
      return "approve";
    case "proposal":
      return "found";
    case "revising":
    case "grouping":
      return "implement";
    case "grouped":
      return "implement";
    case "pr-review":
    case "pr-fixing":
    case "pr-push":
      return "checks";
    case "final-review":
      return t.autoMerge || autoFinal(t) ? "merge" : "final";
    default:
      return "merge";
  }
}

function steps(current, { failed = false, allDone = false } = {}) {
  const at = STEPS.findIndex(([k]) => k === current);
  return STEPS.map(([key, label], i) => ({
    key,
    label,
    state: allDone || i < at ? "done" : i === at ? (failed ? "failed" : "current") : "todo",
  }));
}

// live: { task, line, files, since } when the loop works on this ticket now. pr: checks summary plus
// codex state for its open PR.
export function progressOf(t, { live = null, pr = null } = {}) {
  if (t.status === "merged") return { steps: steps("merge", { allDone: true }), detail: null, since: null, active: false, ratio: null };
  if (t.status === "rejected") return { steps: steps("approve", { failed: true }), detail: null, since: null, active: false, ratio: null };
  if (t.status === "closed") return { steps: steps("merge", { failed: true }), detail: null, since: null, active: false, ratio: null };

  if (live) {
    const { step, detail } = liveStep(live.task, live.line, live.files);
    return { steps: steps(step), detail, since: live.since, active: true, ratio: null };
  }
  const step = baseStep(t);
  const failed = t.status === "needs-human" || (t.status === "final-review" && realNote(t));
  const base = { steps: steps(step, { failed }), detail: null, since: t.updatedAt ?? null, active: false, ratio: null };
  switch (t.status) {
    case "awaiting":
      return { ...base, detail: t.route?.auto ? "watch가 곧 PR을 만듦" : "사람의 진행 결정 대기" };
    case "needs-human":
      return { ...base, detail: "판단 필요" };
    case "proposal":
      return { ...base, detail: "제안서 승인 대기" };
    case "revising":
    case "grouping":
      return { ...base, detail: "루프 차례 대기" };
    case "grouped":
      return { ...base, detail: `${t.groupId} 묶음에서 함께 수정` };
    case "pr-review": {
      const c = checksDetail(pr);
      return { ...base, detail: c.detail ?? "CI·Codex 대기", ratio: c.ratio };
    }
    case "pr-fixing":
      return { ...base, detail: `PR 수정 라운드 ${(t.pr?.round ?? 0) + 1} · 루프 차례 대기` };
    case "pr-push":
      return { ...base, detail: "다음 watch에서 push" };
    case "final-review": {
      if (autoFinal(t) && !t.autoMerge) return { ...base, detail: "자동 머지 기준 다시 확인 대기", active: true };
      if (!t.autoMerge) return { ...base, detail: realNote(t) ? "남은 문제 확인 필요" : "머지 결정 대기" };
      if (t.autoMerge.checking) return { ...base, detail: "최신 main과 합쳐 lint·typecheck 확인 중", active: true, since: t.autoMerge.checking };
      if (t.autoMerge.held) return { ...base, detail: "머지 후 main 검사가 실패해 머지 보류", active: false, since: t.autoMerge.held };
      const c = checksDetail(pr);
      return { ...base, detail: c.detail ?? "CI 대기", active: true, ratio: c.ratio, since: t.autoMerge.at ?? base.since };
    }
    default:
      return base;
  }
}

// The exploration lane's card while it has no ticket yet: a free exploration (use, then judge
// session) or the fix of one finding, which goes through the same steps as a ticket's candidate.
const EXPLORE_DETAIL = {
  탐색: "사용 세션: 앱을 쓰며 단계를 기록하는 중",
  판정: "판정 세션: 기대와 다른 단계를 재현하는 중",
  "제안 작성": "제안서 세션: 제품 문서와 코드를 보고 제안서를 쓰는 중",
};

export function exploringOf(live) {
  const card = { task: live.task ?? "탐색", title: live.title ?? "자유 탐색", area: live.screen ?? null, track: live.track && live.track !== "fix" ? "improve" : "fix" };
  if (live.task !== "결함 수정") {
    return { ...card, progress: { steps: steps("found"), detail: EXPLORE_DETAIL[card.task] ?? EXPLORE_DETAIL.탐색, since: live.since, active: true, ratio: null } };
  }
  const { step, detail } = liveStep(live.task, live.line, live.files);
  return { ...card, progress: { steps: steps(live.line ? step : "found"), detail: live.line ? detail : "결함 재현 준비 중", since: live.since, active: true, ratio: null } };
}

export function groupOf(t) {
  if (t.group) return { role: "group", members: t.group.members };
  if (t.groupId) return { role: "member", id: t.groupId };
  return null;
}

// A command waits in the queue until the next watch run (up to a minute or two). The card shows it
// as received and offers no other action meanwhile, which would act on the state before it.
export function cardOf(t, { lines = [], live = null, pr = null, queued = null } = {}) {
  const card = {
    id: t.id,
    title: t.title,
    severity: t.severity ?? "low",
    kind: t.kind ?? null,
    // 수정 board (defects) or 추가 board (improvements and feature proposals).
    track: t.track && t.track !== "fix" ? "improve" : "fix",
    proposal: t.track === "propose",
    humanRevised: Boolean(t.humanTouched),
    status: t.status,
    column: columnOf(t),
    stage: stageOf(t),
    pr: t.pr ? { number: t.pr.number, url: t.pr.url } : t.resolvedBy ? { number: t.resolvedBy.number, url: t.resolvedBy.url } : null,
    autoMerge: Boolean(t.autoMerge) && !TERMINAL.includes(t.status),
    // lib/route.mjs: auto when the ticket merges without the human, else the reasons the human decides.
    route: t.route ? { auto: t.route.auto, reasons: t.route.reasons } : null,
    autoMerged: t.status === "merged" && Boolean(t.autoMerge?.auto || t.autoMerge?.final),
    group: groupOf(t),
    blocked: blockedOf(t, lines),
    progress: progressOf(t, { live, pr }),
    actions: actionsOf(t),
    reviseAdvice: t.reviseAdvice ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    queued: queued ? { verb: queued.verb, at: queued.at, message: queued.message } : null,
  };
  if (!queued) return card;
  return {
    ...card,
    stage: `${queued.verb} 요청 접수됨`,
    progress: { ...card.progress, detail: queued.message, since: queued.at, active: true },
    actions: [],
  };
}

// Banner items: repeated failures and processes that stopped.
export function alertsOf(cards, processes, mainBroken, afterMerge = null, recipe = {}, loop = {}) {
  const out = [];
  if (recipe.awaitingApproval?.length) out.push({ text: `레시피 변경 승인 대기 (${recipe.awaitingApproval.join(", ")}). 서버에서 fieldtest recipe show로 보고 승인합니다`, ticket: null });
  else if (recipe.stage === "failed") out.push({ text: `레시피 검증 실패로 탐색을 멈췄습니다. 고친 뒤 서버에서 fieldtest recipe repair로 다시 수리합니다`, ticket: null });
  else if (recipe.phase === "repair" && !["ready", "promoted"].includes(recipe.stage)) out.push({ text: "레시피 수리 중. 끝날 때까지 새 탐색을 멈춥니다", ticket: null });
  if (mainBroken) out.push({ text: "main 검사가 실패해 새 탐색을 멈췄습니다", ticket: null });
  if (loop.failures >= 3) out.push({ text: `에이전트 루프 오류 ${loop.failures}회 연속: ${loop.lastError?.message?.split("\n")[0] ?? ""}`, ticket: null });
  if (afterMerge) out.push({ text: `${afterMerge}. 자동 머지를 멈췄습니다`, ticket: null });
  for (const p of processes) if (p.stale) out.push({ text: `${p.name} 프로세스가 멈춘 것 같습니다`, ticket: null });
  for (const c of cards) {
    if (c.blocked?.repeat) out.push({ text: `${c.id}: 같은 실패가 ${c.blocked.repeat.count}회 반복됨 — ${c.blocked.text.slice(0, 120)}`, ticket: c.id });
  }
  return out;
}
