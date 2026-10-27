import { Check, ChevronRight, MessageSquareQuote, X } from "lucide-react";
import type { Attempt, Finding, GateStep, Round, TicketDetail } from "@/api/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty } from "@/components/error-state";
import { relative, shortDateTime, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ShotRows } from "./shots";

function Gate({ steps }: { steps: GateStep[] }) {
  return (
    <ul className="space-y-1">
      {steps.map((step, i) => (
        <li key={`${step.name}:${i}`} className="text-sm">
          <div className="flex items-center gap-2">
            {step.ok ? (
              <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <X className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
            )}
            <span className={cn(!step.ok && "font-medium text-red-700 dark:text-red-300")}>{step.name}</span>
          </div>
          {!step.ok && step.detail && (
            <pre className="thin-scroll mt-1 ml-5.5 max-h-40 overflow-auto rounded-md bg-red-500/6 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-red-800 dark:text-red-200">
              {step.detail}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

function FindingItem({ finding }: { finding: Finding }) {
  return (
    <li className="space-y-1 rounded-lg border p-3 text-sm">
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0 rounded bg-foreground/8 px-1.5 text-[11px] font-semibold uppercase">
          {finding.severity}
        </span>
        <span className="font-medium">{finding.title}</span>
      </div>
      {finding.condition && <p className="text-muted-foreground">조건: {finding.condition}</p>}
      {finding.actual && <p className="whitespace-pre-wrap">실제: {finding.actual}</p>}
      {finding.expected && <p className="whitespace-pre-wrap text-muted-foreground">기대: {finding.expected}</p>}
      {finding.fix && <p className="whitespace-pre-wrap text-emerald-800 dark:text-emerald-300">수정: {finding.fix}</p>}
    </li>
  );
}

function verdictTone(verdict: string) {
  const v = verdict.toLowerCase();
  if (/(pass|ok|clean|approve|승인|통과)/.test(v)) return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  if (/(fail|reject|block|실패|거절)/.test(v)) return "bg-red-500/12 text-red-700 dark:text-red-300";
  return "bg-amber-500/12 text-amber-800 dark:text-amber-300";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function Node({
  title,
  at,
  failed,
  badge,
  children,
}: {
  title: string;
  at: string | null;
  failed: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const now = useNow();
  return (
    <li className="relative pb-6 pl-7 last:pb-0">
      <span className="absolute top-5 bottom-0 left-[7px] w-px bg-border [li:last-child>&]:hidden" />
      <span
        className={cn(
          "absolute top-1 left-0 size-[15px] rounded-full border-2 bg-background",
          failed ? "border-red-500" : "border-foreground/40",
        )}
      />
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {badge}
        {at && (
          <span className="text-xs text-muted-foreground" title={shortDateTime(at)}>
            {relative(at, now)}
          </span>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </li>
  );
}

function AttemptNode({ attempt }: { attempt: Attempt }) {
  const label = /^\d+$/.test(attempt.n) ? `시도 ${attempt.n}` : `시도 ${attempt.n.replace(/^failed-/, "")} (중단)`;
  return (
    <Node
      title={label}
      at={attempt.at}
      failed={attempt.failed}
      badge={
        attempt.failed && (
          <span className="rounded bg-red-500/12 px-1.5 text-[11px] font-semibold text-red-700 dark:text-red-300">실패</span>
        )
      }
    >
      {attempt.feedback && (
        <aside className="flex gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
          <MessageSquareQuote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-xs font-medium text-muted-foreground">사람이 준 수정 방향</p>
            <p className="whitespace-pre-wrap">{attempt.feedback}</p>
          </div>
        </aside>
      )}
      {attempt.gate && (
        <Section title="검사">
          <Gate steps={attempt.gate} />
        </Section>
      )}
      {attempt.review && (
        <Section title="리뷰">
          <div className="space-y-2">
            <span className={cn("inline-block rounded px-1.5 py-px text-xs font-semibold", verdictTone(attempt.review.verdict))}>
              {attempt.review.verdict}
            </span>
            {attempt.review.findings.length > 0 && (
              <ul className="space-y-2">
                {attempt.review.findings.map((f, i) => (
                  <FindingItem key={`${f.title}:${i}`} finding={f} />
                ))}
              </ul>
            )}
            {attempt.review.notChecked && (
              <p className="text-xs text-muted-foreground">확인하지 못한 범위: {attempt.review.notChecked}</p>
            )}
          </div>
        </Section>
      )}
      {attempt.shots.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            스크린샷 {attempt.shots.length}쌍
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <ShotRows rows={attempt.shots} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </Node>
  );
}

function RoundNode({ round }: { round: Round }) {
  const failed = round.gate?.some((g) => !g.ok) ?? false;
  return (
    <Node
      title={`PR 수정 라운드 ${round.n}`}
      at={round.at}
      failed={failed}
      badge={
        round.status && (
          <span className="rounded bg-foreground/8 px-1.5 text-[11px] font-medium text-muted-foreground">{round.status}</span>
        )
      }
    >
      {round.summary && <p className="text-sm whitespace-pre-wrap">{round.summary}</p>}
      {round.reason && <p className="text-sm whitespace-pre-wrap text-muted-foreground">이유: {round.reason}</p>}
      {round.gate && (
        <Section title="검사">
          <Gate steps={round.gate} />
        </Section>
      )}
    </Node>
  );
}

export function AttemptsTab({ detail }: { detail: TicketDetail }) {
  if (detail.attempts.length === 0 && detail.rounds.length === 0) return <Empty>아직 시도가 없습니다</Empty>;
  return (
    <div className="space-y-8">
      {detail.attempts.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold">구현 시도</h3>
          <ol>
            {detail.attempts.map((a) => (
              <AttemptNode key={a.n} attempt={a} />
            ))}
          </ol>
        </section>
      )}
      {detail.rounds.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold">PR 수정 라운드</h3>
          <ol>
            {detail.rounds.map((r) => (
              <RoundNode key={r.n} round={r} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
