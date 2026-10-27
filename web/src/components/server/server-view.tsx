import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Pause, Play, XCircle } from "lucide-react";
import { AnimatePresence, motion, stagger, useReducedMotion } from "motion/react";
import { type ReactNode, useMemo, useState } from "react";
import { useServer } from "@/api/client";
import type { ServerCheckTime, ServerProcessGroup, ServerService, ServerStatus } from "@/api/types";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { bytes, type Level, percentOf, usageLevel } from "@/lib/format";
import { formatDuration, relative, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { record, type Sample } from "./history";
import { AnimatedNumber, Meter, Sparkline } from "./motion-bits";

// One question per block (PatternFly dashboard guidelines): is the host OK, how busy is it, what is
// keeping it busy. Healthy services and the process list stay out of the way until asked for.
const STALE_MS = 15_000;
const pct = (n: number) => `${Math.round(n)}`;

const LEVEL_TEXT: Record<Level, string> = { ok: "text-ok", warn: "text-warn", critical: "text-destructive" };
const LEVEL_FILL: Record<Level, string> = { ok: "bg-foreground/70", warn: "bg-warn", critical: "bg-destructive" };
const KIND_FILL: Record<string, string> = {
  next: "bg-sky-500",
  check: "bg-violet-500",
  browser: "bg-teal-500",
  claude: "bg-orange-400",
  codex: "bg-pink-500",
  fieldtest: "bg-slate-400",
  other: "bg-slate-300 dark:bg-slate-600",
};

const grid = { hidden: {}, show: { transition: { delayChildren: stagger(0.04) } } };
const rise = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { type: "spring", visualDuration: 0.35, bounce: 0 } } } as const;

function Metric({ title, value, unit, level = "ok", children }: { title: string; value: number; unit?: ReactNode; level?: Level; children: ReactNode }) {
  return (
    <motion.div variants={rise} className="h-full">
      <Card size="sm" className="h-full gap-3 px-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">{title}</span>
          {unit && <span className="text-xs text-muted-foreground tabular-nums">{unit}</span>}
        </div>
        <div className={cn("text-3xl leading-none font-semibold tracking-tight", level !== "ok" && LEVEL_TEXT[level])}>
          <AnimatedNumber value={value} format={pct} />
          <span className="ml-0.5 text-base font-normal text-muted-foreground">%</span>
        </div>
        {children}
      </Card>
    </motion.div>
  );
}

function Health({ services }: { services: ServerService[] }) {
  const down = services.filter((s) => s.active !== "active");
  const Icon = down.length ? XCircle : CheckCircle2;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("flex items-center gap-1 text-sm font-medium", down.length ? "text-destructive" : "text-ok")}>
          <Icon className="size-4" />
          {down.length ? `서비스 ${down.length}개 멈춤` : "정상"}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {services.map((s) => (
          <div key={s.unit}>
            {s.label} · {s.active === "active" ? "실행 중" : s.active}
            {s.restarts > 0 && ` · 재시작 ${s.restarts}`}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

// Only a unit that is not running gets a card.
function ServiceAlerts({ services }: { services: ServerService[] }) {
  const down = services.filter((s) => s.active !== "active");
  return (
    <AnimatePresence initial={false}>
      {down.length > 0 && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
          <div role="alert" className="flex flex-col gap-1 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
            {down.map((s) => (
              <div key={s.unit} className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
                <span className="font-medium">{s.label}</span>
                <span className="text-muted-foreground">
                  {s.active}
                  {s.result && s.result !== "success" ? ` (${s.result})` : ""}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// The host CPU split by what runs: one stacked bar plus a short legend that adds up to the CPU card.
// 기타 is the rest of the host: system processes and work that ended inside the sample. Shares under
// 0.5% are left out, so an idle host reads 쉬는 중 rather than a row of 0%.
function CpuByKind({ groups, cores, hostPercent }: { groups: ServerProcessGroup[]; cores: number; hostPercent: number }) {
  const capacity = cores * 100;
  const visible = (cpu: number) => percentOf(cpu, capacity) >= 0.5;
  const shown = groups.filter((g) => g.kind !== "other" && visible(g.cpu));
  const rest = Math.max(0, (hostPercent / 100) * capacity - shown.reduce((a, g) => a + g.cpu, 0));
  const parts = [...shown.map((g) => ({ key: g.kind, label: g.label, cpu: g.cpu })), ...(visible(rest) ? [{ key: "other", label: "기타", cpu: rest }] : [])];
  return (
    <motion.div variants={rise}>
      <Card size="sm" className="gap-3 px-4">
        <span className="text-sm text-muted-foreground">CPU를 쓰는 작업</span>
        <div
          className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={parts.map((p) => `${p.label} ${pct(percentOf(p.cpu, capacity))}%`).join(", ") || "쉬는 중"}
        >
          {parts.map((p) => (
            <motion.div
              key={p.key}
              className={cn("h-full", KIND_FILL[p.key] ?? KIND_FILL.other)}
              initial={false}
              animate={{ width: `${percentOf(p.cpu, capacity)}%` }}
              transition={{ type: "spring", visualDuration: 0.5, bounce: 0 }}
            />
          ))}
        </div>
        {parts.length === 0 ? (
          <span className="text-sm text-muted-foreground">쉬는 중</span>
        ) : (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <AnimatePresence initial={false} mode="popLayout">
              {parts.map((p) => (
                <motion.li key={p.key} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", KIND_FILL[p.key] ?? KIND_FILL.other)} />
                  {p.label}
                  <span className="text-muted-foreground tabular-nums">{pct(percentOf(p.cpu, capacity))}%</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>
    </motion.div>
  );
}

const CHECK_ORDER = ["lint", "typecheck", "test", "build"];
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}초`;

// Median time of main's base checks per vCPU count, to compare instance types over time. Candidate
// gates, replayed turbo runs and failed runs are left out on the server.
function CheckTimes({ checks, cores }: { checks: ServerCheckTime[]; cores: number }) {
  if (checks.length === 0) return null;
  const columns = [...new Set(checks.map((c) => c.cores))].sort((a, b) => a - b);
  const names = CHECK_ORDER.filter((n) => checks.some((c) => c.check === n));
  const cell = (n: string, k: number) => checks.find((c) => c.check === n && c.cores === k);
  return (
    <motion.div variants={rise}>
      <Card size="sm" className="gap-2 px-4">
        <span className="text-sm text-muted-foreground">main 검사 시간 (중앙값, 최근 30회)</span>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>검사</TableHead>
              {columns.map((k) => (
                <TableHead key={k} className={cn("text-right", k === cores && "text-foreground")}>
                  {k} vCPU{k === cores && " · 지금"}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.map((n) => (
              <TableRow key={n}>
                <TableCell className="font-mono text-xs">{n}</TableCell>
                {columns.map((k) => {
                  const c = cell(n, k);
                  return (
                    <TableCell key={k} className="text-right tabular-nums">
                      {c ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              {seconds(c.medianMs)}
                              <span className="ml-1 text-xs text-muted-foreground">{c.runs}회</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            마지막 {seconds(c.lastMs)}
                            {c.medianLoad !== null && ` · load 중앙값 ${c.medianLoad}`}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </motion.div>
  );
}

// "/a/b/node /srv/fieldtest/code/bin/fieldtest.mjs web" → "node fieldtest.mjs web"
function shortCommand(command: string) {
  return command
    .split(" ")
    .map((part) => (part.startsWith("/") ? part.slice(part.lastIndexOf("/") + 1) : part))
    .join(" ");
}

// The busiest processes, folded away by default. CPU is a share of the whole host, like the bar above.
function Processes({ s }: { s: ServerStatus }) {
  const [open, setOpen] = useState(false);
  const share = (cpu: number) => cpu / s.cpu.cores;
  const top = s.top.filter((p) => share(p.cpu) >= 0.5).slice(0, 5);
  return (
    <motion.div variants={rise}>
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        프로세스 보기
      </Button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", visualDuration: 0.3, bounce: 0 }}
            className="overflow-hidden"
          >
            {top.length === 0 && <li className="px-1 py-2 text-sm text-muted-foreground">CPU를 쓰는 프로세스가 없습니다.</li>}
            <AnimatePresence initial={false} mode="popLayout">
              {top.map((p) => (
                <motion.li key={p.pid} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-3 px-1 py-1.5 text-sm">
                  <span className={cn("size-2 shrink-0 rounded-full", KIND_FILL[p.kind] ?? KIND_FILL.other)} />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{shortCommand(p.command)}</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xl font-mono text-[11px] break-all">
                      {p.label} · {p.pid} · {shortCommand(p.command)}
                    </TooltipContent>
                  </Tooltip>
                  <span className="w-12 text-right tabular-nums">{pct(share(p.cpu))}%</span>
                  <span className="w-14 text-right text-muted-foreground tabular-nums">{bytes(p.rssBytes)}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Freshness({ updatedAt, failed, live, onLive }: { updatedAt: number; failed: boolean; live: boolean; onLive: (v: boolean) => void }) {
  const now = useNow();
  const stale = live && (failed || now - updatedAt > STALE_MS);
  return (
    <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
      <span role="status" className={cn("flex items-center gap-1", stale && "font-medium")}>
        {stale && <Clock className="size-3.5" />}
        {live ? relative(new Date(updatedAt).toISOString(), now) : "일시정지"}
      </span>
      <Button variant="ghost" size="icon-sm" aria-pressed={!live} aria-label={live ? "자동 갱신 일시정지" : "자동 갱신 다시 시작"} onClick={() => onLive(!live)}>
        {live ? <Pause /> : <Play />}
      </Button>
    </div>
  );
}

function Header({ s, freshness }: { s: ServerStatus; freshness: ReactNode }) {
  const inst = s.host.instance;
  return (
    <motion.div variants={rise} className="flex items-center gap-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <h2 className="text-lg font-semibold tracking-tight">{inst ? inst.type : s.host.name}</h2>
        </TooltipTrigger>
        <TooltipContent>
          {inst && <div className="font-mono">{inst.id}</div>}
          {inst && <div>{inst.az}</div>}
          <div>
            {s.host.os} · {s.host.arch} · 코어 {s.cpu.cores}개
          </div>
          <div>가동 {formatDuration(s.host.uptimeSec * 1000)}</div>
        </TooltipContent>
      </Tooltip>
      <Health services={s.services} />
      {freshness}
    </motion.div>
  );
}

function ServerSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <Skeleton className="h-8 w-56 rounded-lg" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className={cn("h-32 rounded-xl", i === 2 && "col-span-2 md:col-span-1")} />
        ))}
      </div>
      <Skeleton className="h-24 rounded-xl" />
    </div>
  );
}

export function ServerView() {
  const [live, setLive] = useState(true);
  const server = useServer(live);
  const reduce = useReducedMotion();
  const s = server.data;
  const history: (Sample | null)[] = useMemo(() => (s ? record(s) : []), [s]);

  if (!s) {
    return server.isError ? (
      <ErrorState title="서버 상태를 읽지 못했습니다" error={server.error} onRetry={() => server.refetch()} retrying={server.isFetching} />
    ) : (
      <ServerSkeleton />
    );
  }

  const memUsed = s.memory.totalBytes - s.memory.availableBytes;
  const memPct = percentOf(memUsed, s.memory.totalBytes);
  const diskPct = percentOf(s.disk.totalBytes - s.disk.freeBytes, s.disk.totalBytes);
  const memLevel = usageLevel(memPct);
  const diskLevel = usageLevel(diskPct);
  return (
    <motion.div variants={grid} initial={reduce ? false : "hidden"} animate="show" className="mx-auto flex max-w-3xl flex-col gap-3">
      <Header s={s} freshness={<Freshness updatedAt={server.dataUpdatedAt} failed={server.isRefetchError} live={live} onLive={setLive} />} />
      <ServiceAlerts services={s.services} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Metric title="CPU" value={s.cpu.percent}>
          <Sparkline values={history.map((h) => h?.cpu ?? null)} max={100} className="text-glow" label={`최근 5분 CPU, 지금 ${pct(s.cpu.percent)}%`} />
        </Metric>
        <Metric title="메모리" value={memPct} unit={`${bytes(memUsed)} / ${bytes(s.memory.totalBytes)}`} level={memLevel}>
          <Sparkline
            values={history.map((h) => h?.memory ?? null)}
            max={100}
            className={memLevel === "ok" ? "text-glow-2" : LEVEL_TEXT[memLevel]}
            label={`최근 5분 메모리, 지금 ${pct(memPct)}%`}
          />
        </Metric>
        <div className="col-span-2 md:col-span-1">
          <Metric title="디스크" value={diskPct} unit={`${bytes(s.disk.freeBytes)} 남음`} level={diskLevel}>
            <div className="mt-auto pt-1">
              <Meter percent={diskPct} className={LEVEL_FILL[diskLevel]} label="디스크 사용률" />
            </div>
          </Metric>
        </div>
      </div>
      <CpuByKind groups={s.groups} cores={s.cpu.cores} hostPercent={s.cpu.percent} />
      <CheckTimes checks={s.checks} cores={s.cpu.cores} />
      <Processes s={s} />
    </motion.div>
  );
}
