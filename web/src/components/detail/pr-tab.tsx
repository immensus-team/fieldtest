import { CheckCircle2, ChevronRight, CircleDashed, CircleMinus, ExternalLink, Loader2, XCircle } from "lucide-react";
import { usePrStatus } from "@/api/client";
import type { PrStatus } from "@/api/types";
import { RatioBar } from "@/components/board/progress";
import { Empty, ErrorState } from "@/components/error-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function CheckIcon({ bucket }: { bucket: string }) {
  switch (bucket) {
    case "pass":
      return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />;
    case "fail":
    case "cancel":
      return <XCircle className="size-4 text-red-600 dark:text-red-400" />;
    case "pending":
      return <Loader2 className="size-4 animate-spin text-amber-600 dark:text-amber-400" />;
    case "skipping":
      return <CircleMinus className="size-4 text-muted-foreground" />;
    default:
      return <CircleDashed className="size-4 text-muted-foreground" />;
  }
}

// Failures first, then what is still running.
const BUCKET_ORDER: Record<string, number> = { fail: 0, cancel: 1, pending: 2, pass: 3, skipping: 4 };

function CheckList({ checks }: { checks: PrStatus["checks"] }) {
  return (
    <ul className="divide-y rounded-xl border">
      {checks.map((check, i) => (
        <li key={`${check.name}:${i}`} className="flex items-center gap-2.5 px-3 py-2 text-sm">
          {check.state === "SKIPPED" ? <CircleMinus className="size-4 text-muted-foreground" /> : <CheckIcon bucket={check.bucket} />}
          <span className="min-w-0 flex-1 truncate">{check.name}</span>
          <span className="text-xs text-muted-foreground">{check.state}</span>
          {check.link && (
            <a
              href={check.link}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`${check.name} 열기`}
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

const CODEX: Record<PrStatus["codex"], string> = {
  pending: "Codex 리뷰 대기",
  clean: "Codex 지적 없음",
  findings: "Codex 지적",
};

export function PrTab({ id, hasPr }: { id: string; hasPr: boolean }) {
  const query = usePrStatus(id, hasPr);
  if (!hasPr) return <Empty>아직 PR이 없습니다</Empty>;
  if (query.isPending)
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (query.isError)
    return <ErrorState title="PR 상태를 읽지 못했습니다" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />;

  const pr = query.data;
  const skipped = pr.checks.filter((c) => c.state === "SKIPPED");
  const ran = pr.checks
    .filter((c) => c.state !== "SKIPPED")
    .sort((a, b) => (BUCKET_ORDER[a.bucket] ?? 9) - (BUCKET_ORDER[b.bucket] ?? 9));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-sm font-semibold hover:underline"
        >
          #{pr.number}
          <ExternalLink className="size-3.5 opacity-60" />
        </a>
        <span
          className={cn(
            "rounded px-1.5 py-px text-[11px] font-semibold",
            pr.state === "MERGED" && "bg-violet-500/12 text-violet-700 dark:text-violet-300",
            pr.state === "OPEN" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
            pr.state === "CLOSED" && "bg-red-500/12 text-red-700 dark:text-red-300",
          )}
        >
          {pr.state}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-px text-[11px] font-semibold",
            pr.codex === "clean" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
            pr.codex === "findings" && "bg-amber-500/14 text-amber-800 dark:text-amber-300",
            pr.codex === "pending" && "bg-foreground/8 text-muted-foreground",
          )}
        >
          {CODEX[pr.codex]}
          {pr.codex === "findings" && ` ${pr.findings}건`}
        </span>
      </div>

      {pr.error && (
        <p className="rounded-lg bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">GitHub 조회 실패: {pr.error}</p>
      )}

      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">Required check</span>
          <span className="text-muted-foreground tabular-nums">
            {pr.passed}/{pr.total} 통과
          </span>
        </div>
        {pr.total > 0 && <RatioBar ratio={pr.passed / pr.total} />}
      </div>

      {pr.checks.length > 0 ? (
        <div className="space-y-2">
          {ran.length > 0 && <CheckList checks={ran} />}
          {skipped.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                건너뛴 check {skipped.length}개
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <CheckList checks={skipped} />
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      ) : (
        <Empty className="py-4">check가 아직 없습니다</Empty>
      )}
    </div>
  );
}
