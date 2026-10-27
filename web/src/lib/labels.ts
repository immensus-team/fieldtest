import type { ActionKey, Column, CommandRequest, Severity } from "@/api/types";

export const COLUMNS: { key: Column; label: string }[] = [
  { key: "exploring", label: "탐색 중" },
  { key: "awaiting", label: "승인 대기" },
  { key: "working", label: "진행 중" },
  { key: "final", label: "최종 검토" },
  { key: "done", label: "완료" },
];

export const SEVERITIES: { key: Severity; label: string }[] = [
  { key: "high", label: "높음" },
  { key: "medium", label: "보통" },
  { key: "low", label: "낮음" },
  { key: "trivial", label: "사소" },
];

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, trivial: 3 };

export const SEVERITY_CLASS: Record<Severity, string> = {
  high: "bg-red-500/12 text-red-700 ring-red-500/25 dark:text-red-300 dark:bg-red-500/15",
  medium: "bg-amber-500/14 text-amber-800 ring-amber-500/30 dark:text-amber-300 dark:bg-amber-500/15",
  low: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300 dark:bg-emerald-500/15",
  trivial: "bg-muted text-muted-foreground ring-border",
};

export const KINDS: { key: string; label: string }[] = [
  { key: "functional", label: "기능" },
  { key: "visual", label: "시각" },
  { key: "judgment", label: "판단 필요" },
];

export function kindLabel(kind: string | null) {
  if (!kind) return null;
  return KINDS.find((k) => k.key === kind)?.label ?? kind;
}

export function severityLabel(severity: Severity) {
  return SEVERITIES.find((s) => s.key === severity)?.label ?? severity;
}

export type ActionDef = {
  label: string;
  verb: CommandRequest["verb"];
  // confirm: AlertDialog. text: a dialog that needs a message.
  input: "confirm" | "text";
  title: string;
  description: string;
  placeholder?: string;
  variant: "default" | "outline" | "destructive" | "secondary";
};

export const ACTIONS: Record<ActionKey, ActionDef> = {
  approve: {
    label: "진행",
    verb: "승인",
    input: "confirm",
    title: "이 티켓을 진행할까요?",
    description: "후보 수정으로 PR을 엽니다. 최신 main과 충돌하면 PR 대신 재구현을 요청합니다.",
    variant: "default",
  },
  adopt: {
    label: "추천대로 수정",
    verb: "수정",
    input: "text",
    title: "추천대로 수정",
    description: "추천 수정 방향을 채워 두었습니다. 고쳐서 보내도 됩니다. 에이전트가 이전 수정을 버리고 처음부터 다시 구현합니다.",
    variant: "secondary",
  },
  revise: {
    label: "수정",
    verb: "수정",
    input: "text",
    title: "새 요구사항",
    description: "에이전트가 이전 수정을 버리고 이 요구사항대로 처음부터 다시 구현합니다.",
    placeholder: "예: Y축 글자 크기를 X축과 맞추기",
    variant: "outline",
  },
  reject: {
    label: "거절",
    verb: "거절",
    input: "text",
    title: "거절 이유",
    description: "티켓을 닫습니다. PR이 열려 있으면 merge하지 않고 닫습니다. 이유는 다음 탐색에서 같은 문제를 다시 올리지 않는 데 씁니다.",
    placeholder: "예: 이미 다른 PR에서 고침",
    variant: "destructive",
  },
  merge: {
    label: "머지",
    verb: "머지",
    input: "confirm",
    title: "PR을 머지할까요?",
    description: "깨끗하고 최신이면 바로 squash merge합니다. main이 앞서 있으면 브랜치를 맞추고 CI가 통과한 뒤 자동으로 머지합니다.",
    variant: "default",
  },
  feedback: {
    label: "수정 요청",
    verb: "수정",
    input: "text",
    title: "PR에서 고칠 점",
    description: "에이전트가 같은 PR에 수정 commit을 올립니다. Codex 리뷰와 CI를 다시 거쳐 최종 검토로 돌아옵니다.",
    placeholder: "PR에서 고칠 점을 적어 주세요",
    variant: "outline",
  },
};

// Buttons keep this order whatever order the server sends.
export const ACTION_ORDER: ActionKey[] = ["approve", "merge", "adopt", "revise", "feedback", "reject"];
