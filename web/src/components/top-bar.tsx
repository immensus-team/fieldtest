import { Moon, Pause, Sun, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { LaneInfo, LoopInfo, Overview, ProcessInfo, Track } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";
import { elapsed, relative, useNow } from "@/lib/time";
import { useOpenTicket } from "@/lib/url-state";
import { cn } from "@/lib/utils";

export type View = "fix" | "add" | "log" | "server";

// 수정 holds defect tickets, 추가 the improvements of existing flows, 로그 the commands, explorations
// and process logs.
export const VIEWS: { key: View; label: string; track?: Track }[] = [
  { key: "fix", label: "수정", track: "fix" },
  { key: "add", label: "추가", track: "improve" },
  { key: "log", label: "로그" },
  { key: "server", label: "서버" },
];

// Cards on a board that wait for the human's decision.
export function decisionsOf(overview: Overview | undefined, track: Track) {
  return overview?.cards.filter((c) => c.track === track && c.actions.length > 0).length ?? 0;
}

const PROCESS_LABEL: Record<ProcessInfo["name"], string> = { loop: "loop", watch: "watch", slack: "Slack" };

function ProcessDot({ process }: { process: ProcessInfo }) {
  const now = useNow();
  const missing = !process.lastAt;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`${PROCESS_LABEL[process.name]} ${process.stale ? "멈춘 것 같음" : "정상"}`}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          <span className="relative flex size-2">
            {!process.stale && !missing && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-40 [animation-duration:2.4s]" />
            )}
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                process.stale ? "bg-red-500" : missing ? "bg-foreground/25" : "bg-emerald-500",
              )}
            />
          </span>
          <span className="hidden sm:inline">{PROCESS_LABEL[process.name]}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {process.runningSince ? (
          <>
            {PROCESS_LABEL[process.name]} 실행 중 ({elapsed(process.runningSince, now)}째)
          </>
        ) : (
          <>
            {PROCESS_LABEL[process.name]} 마지막 기록: {missing ? "없음" : relative(process.lastAt, now)}
          </>
        )}
        {process.stale && " · 멈춘 것 같음"}
      </TooltipContent>
    </Tooltip>
  );
}

function LaneLine({ lane, idle }: { lane: LaneInfo; idle: string | null }) {
  const now = useNow();
  const [, open] = useOpenTicket();
  const tag = (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{lane.label}</span>
  );
  if (lane.task) {
    const target = lane.ticket ?? lane.title ?? lane.screen;
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {tag}
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-glow opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-glow" />
        </span>
        <span className="shrink-0 font-medium">{lane.task}</span>
        {target && (
          <>
            <span className="text-muted-foreground/60">·</span>
            {lane.ticket ? (
              <button
                type="button"
                className="truncate font-mono text-[13px] text-foreground/80 underline-offset-4 hover:underline"
                onClick={() => open(lane.ticket)}
              >
                {lane.ticket}
              </button>
            ) : (
              <span className={cn("truncate text-[13px] text-foreground/80", !lane.title && "font-mono")}>{target}</span>
            )}
          </>
        )}
        {lane.since && (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{elapsed(lane.since, now)}</span>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      {tag}
      <Pause className="size-3.5 shrink-0" />
      <span className="shrink-0">대기</span>
      {idle && (
        <>
          <span className="text-muted-foreground/60">·</span>
          <span className="truncate">{idle}</span>
        </>
      )}
    </div>
  );
}

function LoopLine({ loop }: { loop: LoopInfo }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
      {loop.lanes.map((lane) => (
        <LaneLine key={lane.name} lane={lane} idle={lane.name === "explore" ? loop.idle : null} />
      ))}
    </div>
  );
}

function ApprovalCount({ approval }: { approval: Overview["approval"] }) {
  const full = approval.count >= approval.limit;
  const near = !full && approval.count >= approval.limit - 2;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium tabular-nums ring-1 ring-inset",
            full && "bg-red-500/10 text-red-700 ring-red-500/30 dark:text-red-300",
            near && "bg-amber-500/12 text-amber-800 ring-amber-500/30 dark:text-amber-300",
            !full && !near && "text-muted-foreground ring-border",
          )}
        >
          <span className="hidden sm:inline">승인 대기</span>
          <span className="sm:hidden">승인</span>
          <span className="font-semibold">
            {approval.count}/{approval.limit}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {full ? "한도에 닿아 루프가 새 탐색을 멈춥니다" : `한도 ${approval.limit}개에 닿으면 루프가 새 탐색을 멈춥니다`}
      </TooltipContent>
    </Tooltip>
  );
}

export function TopBar({
  overview,
  offline,
  onRetry,
  view,
  onView,
}: {
  overview: Overview | undefined;
  offline: boolean;
  onRetry: () => void;
  view: View;
  onView: (view: View) => void;
}) {
  const { theme, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md supports-backdrop-filter:bg-background/70">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-5">
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-[11px] font-bold text-background">
            U
          </span>
          <span className="text-[15px] font-semibold tracking-tight">fieldtest</span>
        </div>
        <div className="order-last w-full min-w-0 lg:order-none lg:w-auto lg:flex-1">
          {overview && <LoopLine loop={overview.loop} />}
        </div>
        <div className="ml-auto flex items-center gap-1 lg:ml-0">
          {offline && (
            <Button variant="destructive" size="xs" onClick={onRetry}>
              <WifiOff />
              연결 끊김 · 다시 시도
            </Button>
          )}
          {overview?.loop.processes.map((p) => <ProcessDot key={p.name} process={p} />)}
          {overview && <ApprovalCount approval={overview.approval} />}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggle}
            aria-label={theme === "dark" ? "라이트 테마로 바꾸기" : "다크 테마로 바꾸기"}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </div>
      <div className="px-4 sm:px-5">
        <Tabs value={view} onValueChange={(v) => onView(v as View)}>
          <TabsList variant="line" className="h-9 gap-1 p-0">
            {VIEWS.map((v) => {
              const count = v.track ? decisionsOf(overview, v.track) : 0;
              return (
                <TabsTrigger key={v.key} value={v.key} className="px-2.5 after:hidden">
                  {v.label}
                  <AnimatePresence initial={false}>
                    {count > 0 && (
                      <motion.span
                        key="count"
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.6 }}
                        transition={{ type: "spring", visualDuration: 0.2, bounce: 0 }}
                        aria-label={`결정할 티켓 ${count}개`}
                        className="rounded-full bg-amber-500/15 px-1.5 text-[11px] leading-[18px] font-semibold text-warn tabular-nums"
                      >
                        {count}
                      </motion.span>
                    )}
                  </AnimatePresence>
                  {/* One underline that slides to the selected tab (shared layout). */}
                  {view === v.key && (
                    <motion.span
                      layoutId="view-tab"
                      aria-hidden="true"
                      className="absolute inset-x-1 -bottom-[5px] h-0.5 rounded-full bg-foreground"
                      transition={{ type: "spring", visualDuration: 0.3, bounce: 0 }}
                    />
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>
    </header>
  );
}
