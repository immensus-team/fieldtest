import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useExplore, useSession } from "@/api/client";
import type { ExploreFinding, ExploreSession, FindingStatus, SessionStep, Verdict } from "@/api/types";
import { SeverityBadge, TrackBadge } from "@/components/board/badges";
import { Empty, ErrorState } from "@/components/error-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { relative, shortDateTime, useNow } from "@/lib/time";
import { useOpenTicket } from "@/lib/url-state";
import { cn } from "@/lib/utils";

const chip = "inline-flex items-center rounded px-1.5 py-px text-[11px] font-semibold whitespace-nowrap";

const FINDING_STATUS: Record<FindingStatus, { label: string; className: string }> = {
  open: { label: "고치기 전", className: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  fixing: { label: "고치는 중", className: "bg-sky-500/20 text-sky-800 dark:text-sky-200" },
  ticketed: { label: "티켓", className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" },
  dropped: { label: "버림", className: "bg-muted text-muted-foreground" },
  blocked: { label: "막힘", className: "bg-red-500/12 text-red-700 dark:text-red-300" },
};

const VERDICTS: Record<Verdict, { label: string; className: string }> = {
  defect: { label: "결함", className: "bg-red-500/12 text-red-700 dark:text-red-300" },
  improvement: { label: "개선", className: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  proposal: { label: "제안", className: "bg-violet-500/12 text-violet-700 dark:text-violet-300" },
  "agent-error": { label: "사용 실수", className: "bg-muted text-muted-foreground" },
  intended: { label: "의도된 동작", className: "bg-muted text-muted-foreground" },
  duplicate: { label: "중복", className: "bg-amber-500/14 text-amber-800 dark:text-amber-300" },
  trivial: { label: "사소", className: "bg-muted text-muted-foreground" },
  "not-reproduced": { label: "재현 안 됨", className: "bg-muted text-muted-foreground" },
};

const SESSION_STATUS: Record<NonNullable<ExploreSession["status"]>, string> = {
  using: "사용 세션 중",
  judging: "판정 세션 중",
  done: "끝남",
  failed: "실패",
};

export function ExploreView() {
  const query = useExplore();

  if (query.isPending) return <Skeleton className="h-80 w-full" />;
  if (query.isError && !query.data)
    return <ErrorState title="탐색 기록을 읽지 못했습니다" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">발견</h2>
        {query.data.findings.length === 0 ? <Empty>아직 발견이 없습니다</Empty> : <FindingsTable findings={query.data.findings} />}
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">최근 탐색</h2>
        {query.data.sessions.length === 0 ? (
          <Empty>아직 탐색 기록이 없습니다</Empty>
        ) : (
          <div className="space-y-2">
            {query.data.sessions.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function FindingsTable({ findings }: { findings: ExploreFinding[] }) {
  const now = useNow();
  const [, open] = useOpenTicket();
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-20">번호</TableHead>
            <TableHead className="w-24">상태</TableHead>
            <TableHead className="w-16">심각도</TableHead>
            <TableHead className="w-24">영역</TableHead>
            <TableHead className="min-w-64">제목</TableHead>
            <TableHead className="min-w-48">결과</TableHead>
            <TableHead className="w-24">시각</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((f) => (
            <TableRow key={f.id}>
              <TableCell className="font-mono text-xs font-medium">{f.id}</TableCell>
              <TableCell>
                <span className={cn(chip, FINDING_STATUS[f.status]?.className)}>{FINDING_STATUS[f.status]?.label ?? f.status}</span>
              </TableCell>
              <TableCell>
                <SeverityBadge severity={f.severity} />
              </TableCell>
              <TableCell className="font-mono text-xs">{f.area}</TableCell>
              <TableCell className="max-w-[28rem] whitespace-normal">
                <TrackBadge track={f.track} proposal={f.proposal} /> {f.title}
              </TableCell>
              <TableCell className="max-w-[24rem] whitespace-normal text-muted-foreground">
                {f.ticket ? (
                  <button
                    type="button"
                    onClick={() => open(f.ticket)}
                    className="font-mono text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {f.ticket}
                  </button>
                ) : (
                  <span className="line-clamp-2">{f.reason ?? "-"}</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums" title={shortDateTime(f.updatedAt)}>
                {relative(f.updatedAt, now)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SessionRow({ session: s }: { session: ExploreSession }) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const verdicts = Object.entries(s.verdicts ?? {}).filter(([, n]) => n) as [Verdict, number][];
  const conditions = s.conditions ? `${s.conditions.width}px · ${s.conditions.theme} · ${s.conditions.input}` : null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <CollapsibleTrigger className="flex w-full items-start gap-2 p-3 text-left">
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span title={shortDateTime(s.at)}>{relative(s.at, now)}</span>
            {conditions && <span>{conditions}</span>}
            {s.status && (
              <span className={cn(s.status === "failed" && "font-medium text-red-600 dark:text-red-400")}>{SESSION_STATUS[s.status]}</span>
            )}
          </div>
          <p className="text-sm font-medium break-words">{s.goal ?? "목표를 정하는 중"}</p>
          {s.persona && <p className="text-xs text-muted-foreground break-words">{s.persona}</p>}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {s.steps !== null && (
              <span className="text-muted-foreground tabular-nums">
                {s.steps}단계 · 기대와 다름 {s.mismatched ?? 0}
                {s.friction ? ` · 마찰 ${s.friction}` : ""}
                {s.goalReached === false && " · 목표 못 이룸"}
              </span>
            )}
            {verdicts.map(([v, n]) => (
              <span key={v} className={cn(chip, VERDICTS[v]?.className)}>
                {VERDICTS[v]?.label ?? v} {n}
              </span>
            ))}
            {s.unjudged.length > 0 && <span className={cn(chip, "bg-amber-500/14 text-amber-800 dark:text-amber-300")}>판정 없음 {s.unjudged.length}</span>}
            {s.findings.length > 0 && <span className="font-mono text-muted-foreground">{s.findings.join(", ")}</span>}
          </div>
          {s.error && <p className="line-clamp-2 text-xs text-red-600 dark:text-red-400">{s.error}</p>}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SessionSteps id={s.id} enabled={open} summary={s.summary} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function SessionSteps({ id, enabled, summary }: { id: string; enabled: boolean; summary: string | null }) {
  const query = useSession(id, enabled);
  if (query.isPending) return <Skeleton className="mx-3 mb-3 h-24" />;
  if (query.isError && !query.data)
    return (
      <div className="px-3 pb-3">
        <ErrorState title="단계를 읽지 못했습니다" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />
      </div>
    );
  return (
    <div className="space-y-2 border-t px-3 py-3">
      {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
      {query.data.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">기록된 단계가 아직 없습니다</p>
      ) : (
        <ol className="space-y-2">
          {query.data.steps.map((st) => (
            <StepItem key={st.n} step={st} />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepItem({ step: st }: { step: SessionStep }) {
  return (
    <li className={cn("rounded-lg border p-2.5 text-sm", !st.matched && "border-amber-500/40 bg-amber-500/5")}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{st.n}</span>
        <span className="font-mono">{st.area}</span>
        {st.probe && <span className={cn(chip, "bg-muted")}>찔러 보기</span>}
        {!st.matched && <span className={cn(chip, "bg-amber-500/14 text-amber-800 dark:text-amber-300")}>기대와 다름</span>}
        {st.matched && st.friction && <span className={cn(chip, "bg-sky-500/12 text-sky-700 dark:text-sky-300")}>마찰</span>}
        {st.verdict && <span className={cn(chip, VERDICTS[st.verdict]?.className)}>{VERDICTS[st.verdict]?.label ?? st.verdict}</span>}
        {st.duplicateOf && <span className="font-mono">{st.duplicateOf}</span>}
      </div>
      <p className="break-words">{st.action}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
        <dt className="text-muted-foreground">기대</dt>
        <dd className="break-words">{st.expected}</dd>
        <dt className="text-muted-foreground">실제</dt>
        <dd className="break-words">{st.actual}</dd>
        {st.friction && (
          <>
            <dt className="text-muted-foreground">마찰</dt>
            <dd className="break-words">{st.friction}</dd>
          </>
        )}
        {st.reason && (
          <>
            <dt className="text-muted-foreground">판정</dt>
            <dd className="break-words">{st.reason}</dd>
          </>
        )}
      </dl>
      {(st.shot || st.judgeShot) && (
        <div className="mt-1.5 flex gap-3 text-xs">
          {st.shot && (
            <a href={st.shot} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
              사용 화면
            </a>
          )}
          {st.judgeShot && (
            <a href={st.judgeShot} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
              판정 재현 화면
            </a>
          )}
        </div>
      )}
    </li>
  );
}
