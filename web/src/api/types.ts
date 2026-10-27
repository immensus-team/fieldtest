// The JSON the local server (lib/web.mjs) returns. lib/view.mjs builds these shapes.

export type Column = "exploring" | "awaiting" | "working" | "final" | "done";
export type Severity = "high" | "medium" | "low" | "trivial";
export type ActionKey = "approve" | "reject" | "revise" | "adopt" | "merge" | "feedback";

// One dot of the card's stepper. Steps: 발견, 구현, 검사, 리뷰, 승인, PR, CI·Codex, 최종 검토, 머지.
export interface Step {
  key: "found" | "implement" | "gate" | "review" | "approve" | "pr" | "checks" | "final" | "merge";
  label: string;
  state: "done" | "current" | "todo" | "failed";
}

export interface Progress {
  steps: Step[];
  // What is happening now, e.g. "구현 세션 2/3", "CI 4/6 통과 · Codex 대기". Null when nothing runs.
  detail: string | null;
  // When the current step started (ISO), for the elapsed-time counter.
  since: string | null;
  // True while the loop or an auto-merge is working on this card right now.
  active: boolean;
  // 0..1 for a progress bar (CI checks passed / total), null when there is none.
  ratio: number | null;
}

export interface Blocked {
  text: string;
  tone: "warn" | "error";
  // The same failure in a row in the logs, e.g. a push that fails every minute.
  repeat: { count: number; last: string } | null;
}

export interface Card {
  id: string;
  title: string;
  severity: Severity;
  kind: string | null; // "functional" | "visual" | "judgment" | null
  track: Track;
  proposal: boolean; // a feature proposal: a spec without code until the human approves it
  humanRevised: boolean; // the human sent 수정 at least once
  status: string; // raw status, e.g. "pr-fixing"
  column: Column;
  stage: string; // Korean stage label, e.g. "PR 수정 라운드 2"
  pr: { number: number; url: string } | null;
  autoMerge: boolean;
  // lib/route.mjs: auto when the ticket goes from ticket to merge without the human; reasons say why
  // the human decides otherwise. Null before watch has judged the candidate.
  route: { auto: boolean; reasons: string[] } | null;
  autoMerged: boolean; // merged on the automatic route
  group: { role: "group"; members: string[] } | { role: "member"; id: string } | null;
  blocked: Blocked | null;
  progress: Progress;
  actions: ActionKey[];
  reviseAdvice: string | null;
  createdAt: string;
  updatedAt: string;
  // A command waiting for watch. Stage and progress then say it was received, and actions is empty.
  queued: { verb: string; at: string; message: string } | null;
}

// What the exploration lane does while it has no ticket: a free exploration (탐색, then 판정) or the
// fix of one finding (결함 수정).
// Which board a ticket belongs to: 수정 (defects) or 추가 (improvements of existing flows).
export type Track = "fix" | "improve";

export interface Exploring {
  task: "탐색" | "판정" | "결함 수정";
  track: Track; // free exploration counts as fix
  title: string; // the exploration's conditions or goal, or "F-0003 <finding title>"
  area: string | null; // the finding's area while fixing it
  progress: Progress;
}

export interface ProcessInfo {
  name: "loop" | "watch" | "slack";
  lastAt: string | null; // last log line time (watch: when its last run ended)
  runningSince: string | null; // watch only: start of the run in progress
  stale: boolean; // loop, Slack: systemd unit not running; watch: no run in progress and none ended in 5 minutes
}

// The loop runs two lanes at once: "pr" (PR 수정, 카드, 원인 분류) and "explore" (탐색, 재구현, 묶음).
export interface LaneInfo {
  name: "pr" | "explore";
  label: string; // "PR" | "탐색"
  task: string | null; // e.g. "재구현", "PR 수정", "탐색"; null while the lane waits
  ticket: string | null;
  screen: string | null;
  title: string | null;
  since: string | null;
}

export interface LoopInfo {
  lanes: LaneInfo[];
  idle: string | null; // why the exploration lane waits, e.g. "승인 대기 티켓 10개 이상"
  processes: ProcessInfo[];
}

export interface Command {
  at: string;
  id: string;
  verb: string; // 승인 | 거절 | 수정 | 머지
  arg: string;
  source: "slack" | "web";
  // null while queued (not run by watch yet).
  ok: boolean | null;
  message: string;
  // Ticket detail only: what the command led to later (재구현, PR 수정 라운드, 머지). Null while it runs.
  outcome?: { at: string; ok: boolean; text: string } | null;
}

export interface Overview {
  now: string;
  loop: LoopInfo;
  approval: { count: number; limit: number };
  exploring: Exploring | null;
  cards: Card[];
  // Problems worth a banner: repeated failures, stale processes.
  alerts: { text: string; ticket: string | null }[];
  commands: Command[]; // newest first, last 30
}

export interface CardSummary {
  summary: string;
  expected: string;
  actual: string;
  cause: string;
  fix: string[];
}

export interface ShotRow {
  label: string; // "390px · 라이트"
  before: string | null; // URL under /api/files/...
  after: string | null;
}

export interface GateStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Finding {
  severity: string;
  title: string;
  condition?: string;
  expected?: string;
  actual?: string;
  evidence?: string;
  fix?: string;
}

export interface Attempt {
  n: string; // "1", "2", "failed-1-1792..."
  failed: boolean;
  at: string | null;
  feedback: string | null; // the human's 수정 direction for this attempt
  gate: GateStep[] | null;
  review: { verdict: string; findings: Finding[]; notChecked?: string } | null;
  shots: ShotRow[];
}

export interface Round {
  n: number;
  at: string | null;
  status: string | null; // result.json status
  summary: string | null;
  reason: string | null;
  gate: GateStep[] | null;
}

export interface LogLine {
  source: "loop" | "watch" | "slack";
  at: string | null;
  text: string;
}

export interface TicketDetail {
  card: Card;
  summary: CardSummary | null;
  ticketMd: string;
  notes: { label: string; text: string }[]; // prNote, reviseNote, needsHumanReason, rejectReason
  shots: ShotRow[]; // the current candidate's before/after
  attempts: Attempt[];
  rounds: Round[];
  logs: LogLine[]; // newest last, this ticket only
  commands: Command[];
}

export interface PrStatus {
  number: number;
  url: string;
  state: string; // OPEN | MERGED | CLOSED
  checks: { name: string; state: string; bucket: string; link?: string }[];
  passed: number;
  total: number;
  codex: "pending" | "clean" | "findings";
  findings: number;
  error?: string;
}

export type FindingStatus = "open" | "fixing" | "ticketed" | "dropped" | "blocked";

// A defect a judge session found; the exploration lane fixes the open ones into tickets.
export interface ExploreFinding {
  id: string;
  status: FindingStatus;
  area: string;
  severity: "high" | "medium" | "low";
  kind: string;
  track: Track;
  proposal: boolean;
  title: string;
  session: string;
  ticket: string | null;
  reason: string | null; // why it was dropped or blocked
  createdAt: string;
  updatedAt: string;
}

export type Verdict = "defect" | "improvement" | "proposal" | "agent-error" | "intended" | "duplicate" | "trivial" | "not-reproduced";

// One free exploration: a use session's goal and steps, then the judge session's verdicts.
export interface ExploreSession {
  id: string;
  at: string | null;
  status: "using" | "judging" | "done" | "failed" | null;
  conditions: { width: number; theme: string; input: string } | null;
  persona: string | null;
  goal: string | null;
  goalReached: boolean | null;
  summary: string | null;
  steps: number | null;
  mismatched: number | null;
  friction: number | null; // steps that went as expected with friction
  verdicts: Partial<Record<Verdict, number>> | null;
  unjudged: number[];
  findings: string[];
  error: string | null;
}

export interface ExploreInfo {
  findings: ExploreFinding[];
  sessions: ExploreSession[];
}

export interface SessionStep {
  n: number;
  area: string;
  url: string;
  probe: boolean;
  action: string;
  expected: string;
  actual: string;
  matched: boolean;
  friction?: string; // older sessions have none
  shot: string | null;
  judgeShot: string | null;
  verdict: Verdict | null;
  reason: string | null;
  duplicateOf: string | null;
}

export interface SessionDetail {
  id: string;
  steps: SessionStep[];
}

export interface CommandRequest {
  verb: "승인" | "거절" | "수정" | "머지";
  arg?: string;
}

// GET /api/server (lib/host.mjs): the EC2 host the agent runs on.
export interface ServerService {
  unit: string;
  label: string;
  active: string; // systemd ActiveState: active, activating, inactive, failed …
  sub: string;
  since: string | null;
  restarts: number;
  memoryBytes: number | null;
  pid: number | null;
  result: string;
}

export interface ServerProcessGroup {
  kind: string;
  label: string;
  count: number;
  cpu: number; // percent of one core, summed
  rssBytes: number;
}

export interface ServerProcess {
  pid: number;
  user: string;
  kind: string;
  label: string;
  cpu: number;
  rssBytes: number;
  startedAt: string;
  command: string;
}

export interface ServerCheckTime {
  cores: number;
  check: string;
  runs: number;
  medianMs: number;
  lastMs: number;
  lastAt: string;
  medianLoad: number | null;
}

export interface ServerStatus {
  at: string;
  host: {
    name: string;
    os: string;
    kernel: string;
    arch: string;
    uptimeSec: number;
    instance: { id: string; type: string; az: string; region: string } | null;
  };
  cpu: { percent: number; cores: number; load: [number, number, number] };
  memory: { totalBytes: number; availableBytes: number; swapTotalBytes: number; swapUsedBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number };
  services: ServerService[];
  slack: boolean; // false: Slack was skipped in the wizard
  version: { current: string | null; waiting: string | null };
  checks: ServerCheckTime[];
  groups: ServerProcessGroup[];
  top: ServerProcess[];
}
