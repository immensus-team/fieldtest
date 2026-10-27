import { useEffect, useState } from "react";
import { useTicket } from "@/api/client";
import type { TicketDetail } from "@/api/types";
import { AutoMergeBadge, AutoRouteBadge, BlockedLine, GroupChip, KindBadge, PrChip, SeverityBadge, TrackBadge } from "@/components/board/badges";
import { ProgressDetail, Stepper } from "@/components/board/progress";
import { ErrorState } from "@/components/error-state";
import { LogView } from "@/components/log-view";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { relative, useNow } from "@/lib/time";
import { useOpenTicket } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { ActionBar } from "./actions";
import { AttemptsTab } from "./attempts-tab";
import { PrTab } from "./pr-tab";
import { ShotRows } from "./shots";
import { SummaryTab } from "./summary-tab";

const TABS = [
  { key: "summary", label: "요약" },
  { key: "shots", label: "스크린샷" },
  { key: "attempts", label: "시도" },
  { key: "pr", label: "PR" },
  { key: "logs", label: "로그" },
  { key: "raw", label: "원문" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function Header({ detail }: { detail: TicketDetail }) {
  const now = useNow();
  const { card } = detail;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 pr-8">
        <span className="font-mono text-xs font-medium text-muted-foreground">{card.id}</span>
        <SeverityBadge severity={card.severity} />
        <TrackBadge track={card.track} proposal={card.proposal} />
        <KindBadge kind={card.kind} />
        {card.route?.auto || card.autoMerged ? (
          <AutoRouteBadge merged={card.autoMerged} />
        ) : (
          card.autoMerge && <AutoMergeBadge />
        )}
        {card.group && <GroupChip group={card.group} />}
        {card.pr && <PrChip pr={card.pr} />}
      </div>
      <SheetTitle className="text-lg leading-snug font-semibold text-pretty">{card.title}</SheetTitle>
      <SheetDescription className="flex flex-wrap items-center gap-x-2 text-xs">
        <span className={cn("font-medium", card.progress.active ? "text-glow" : "text-foreground/80")}>{card.stage}</span>
        <span>·</span>
        <span>만든 지 {relative(card.createdAt, now).replace(" 전", "")}</span>
        <span>·</span>
        <span>{relative(card.updatedAt, now)} 갱신</span>
      </SheetDescription>
      {card.route && !card.route.auto && card.column !== "done" && (
        <p className="text-xs text-muted-foreground">사람 확인 이유: {card.route.reasons.join(", ")}</p>
      )}
      {card.progress.steps.length > 0 && (
        <div className={cn("rounded-xl", card.progress.active && "glow-frame")}>
          <div
            className={cn("space-y-2.5 rounded-xl border bg-popover p-3.5", card.progress.active && "border-transparent")}
          >
            <Stepper steps={card.progress.steps} active={card.progress.active} size="md" labels />
            <ProgressDetail progress={card.progress} />
          </div>
        </div>
      )}
      {card.blocked && (
        // The same reason often shows in full as a note in 요약; keep the header short then.
        <BlockedLine
          blocked={card.blocked}
          clamp={detail.notes.some((n) => n.text.includes(card.blocked?.text ?? "") || card.blocked?.text.includes(n.text))}
        />
      )}
    </div>
  );
}

function Body({ detail, tab, onTab }: { detail: TicketDetail; tab: TabKey; onTab: (tab: TabKey) => void }) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as TabKey)} className="gap-0">
      <div className="thin-scroll sticky top-0 z-10 overflow-x-auto border-b bg-popover/95 px-5 backdrop-blur">
        <TabsList variant="line" className="h-10 gap-1 p-0">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="px-2">
              {t.label}
              {t.key === "shots" && detail.shots.length > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">{detail.shots.length}</span>
              )}
              {t.key === "attempts" && detail.attempts.length + detail.rounds.length > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {detail.attempts.length + detail.rounds.length}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div className="px-5 py-5">
        <TabsContent value="summary">
          <SummaryTab detail={detail} />
        </TabsContent>
        <TabsContent value="shots">
          <ShotRows rows={detail.shots} />
        </TabsContent>
        <TabsContent value="attempts">
          <AttemptsTab detail={detail} />
        </TabsContent>
        <TabsContent value="pr">
          {tab === "pr" && <PrTab id={detail.card.id} hasPr={!!detail.card.pr} />}
        </TabsContent>
        <TabsContent value="logs">
          <LogView lines={detail.logs} showSource className="h-[65dvh] min-h-64" />
        </TabsContent>
        <TabsContent value="raw">
          <pre className="rounded-xl border bg-muted/30 p-4 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap">
            {detail.ticketMd || "원문이 없습니다"}
          </pre>
        </TabsContent>
      </div>
    </Tabs>
  );
}

function Loaded({ id }: { id: string }) {
  const query = useTicket(id);
  const [tab, setTab] = useState<TabKey>("summary");

  if (query.isPending) {
    return (
      <div className="space-y-3 p-5">
        <SheetTitle className="sr-only">{id} 불러오는 중</SheetTitle>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div className="p-5">
        <SheetTitle className="mb-4 font-mono">{id}</SheetTitle>
        <ErrorState
          title="티켓을 불러오지 못했습니다"
          error={query.error}
          onRetry={() => query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }
  const detail = query.data;
  return (
    <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
      <SheetHeader className="gap-4 p-5 pb-4">
        <Header detail={detail} />
        <ActionBar card={detail.card} commands={detail.commands} />
        {query.isError && (
          <p className="text-xs text-amber-700 dark:text-amber-400">갱신 실패: {query.error.message}. 마지막으로 읽은 내용입니다.</p>
        )}
      </SheetHeader>
      <Body detail={detail} tab={tab} onTab={setTab} />
    </div>
  );
}

export function TicketSheet() {
  const [id, setId] = useOpenTicket();
  // Keep the last id while the sheet slides out.
  const [shown, setShown] = useState(id);
  useEffect(() => {
    if (id) setShown(id);
  }, [id]);

  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && setId(null)}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[720px]"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {shown && <Loaded key={shown} id={shown} />}
      </SheetContent>
    </Sheet>
  );
}
