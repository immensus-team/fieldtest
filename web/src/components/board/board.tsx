import { Search, X } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, stagger, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Card, Column, Overview, Severity, Track } from "@/api/types";
import { AnimatedNumber } from "@/components/server/motion-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { COLUMNS, KINDS, SEVERITIES } from "@/lib/labels";
import { msOf } from "@/lib/time";
import { useOpenTicket } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { ExploringCard, TicketCard } from "./ticket-card";

const DONE_PAGE = 20;

const BOARD: Record<Track, { exploring: string; empty: string; idle: string }> = {
  fix: { exploring: "탐색 중", empty: "비어 있습니다", idle: "지금 탐색하거나 고치는 발견이 없습니다" },
  improve: {
    exploring: "개선 중",
    empty: "비어 있습니다",
    idle: "탐색에서 찾은 마찰을 개선 티켓으로 만들면 여기에 나옵니다",
  },
};

// Columns rise in once when the board opens; polling never replays it.
const columnsIn = { hidden: {}, show: { transition: { delayChildren: stagger(0.04) } } };
const columnIn = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { type: "spring", visualDuration: 0.3, bounce: 0 } },
} as const;

const pct = (n: number) => `${Math.round(n)}`;

// Finished tickets of one board, so a change in the mix of work does not read as a change in quality.
function BoardStats({ cards }: { cards: Card[] }) {
  const finished = cards.filter((c) => c.column === "done");
  const merged = finished.filter((c) => c.status === "merged").length;
  const rejected = finished.length - merged;
  const revised = cards.filter((c) => c.humanRevised).length;
  if (cards.length === 0) return null;
  const item = "flex items-baseline gap-1";
  return (
    <dl className="ml-auto flex items-baseline gap-3 text-xs text-muted-foreground">
      <div className={item}>
        <dt>머지</dt>
        <dd className="font-medium text-foreground">
          <AnimatedNumber value={merged} format={pct} />
        </dd>
      </div>
      <div className={item}>
        <dt>거절·닫힘</dt>
        <dd className="font-medium text-foreground">
          <AnimatedNumber value={rejected} format={pct} />
        </dd>
      </div>
      {finished.length > 0 && (
        <div className={item}>
          <dt>머지율</dt>
          <dd className="font-medium text-foreground">
            <AnimatedNumber value={(merged / finished.length) * 100} format={pct} />%
          </dd>
        </div>
      )}
      <div className={cn(item, "hidden sm:flex")}>
        <dt>사람 수정 요청</dt>
        <dd className="font-medium text-foreground">
          <AnimatedNumber value={(revised / cards.length) * 100} format={pct} />%
        </dd>
      </div>
    </dl>
  );
}

// Cards whose status changed since the previous poll glow once.
function useChanged(cards: Card[]) {
  const previous = useRef<Map<string, string> | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());

  useEffect(() => {
    const before = previous.current;
    const next = new Map(cards.map((c) => [c.id, `${c.status}|${c.stage}`]));
    previous.current = next;
    if (!before) return;
    const ids = [...next].filter(([id, value]) => before.has(id) && before.get(id) !== value).map(([id]) => id);
    if (ids.length === 0) return;
    setChanged((current) => new Set([...current, ...ids]));
    const timer = setTimeout(() => {
      setChanged((current) => {
        const rest = new Set(current);
        for (const id of ids) rest.delete(id);
        return rest;
      });
    }, 2600);
    return () => clearTimeout(timer);
  }, [cards]);

  return changed;
}

function byRecent(a: Card, b: Card) {
  return (msOf(b.updatedAt) ?? 0) - (msOf(a.updatedAt) ?? 0);
}

function sortColumn(column: Column, cards: Card[]) {
  if (column === "done") return [...cards].sort(byRecent);
  // The card the loop works on first, then the newest change.
  return [...cards].sort((a, b) => Number(b.progress.active) - Number(a.progress.active) || byRecent(a, b));
}

export function Board({ overview, track }: { overview: Overview; track: Track }) {
  const [, open] = useOpenTicket();
  const reduce = useReducedMotion();
  const text = BOARD[track];
  const own = useMemo(() => overview.cards.filter((c) => c.track === track), [overview.cards, track]);
  const exploring = overview.exploring?.track === track ? overview.exploring : null;
  const [query, setQuery] = useState("");
  const [severities, setSeverities] = useState<Severity[]>([]);
  const [kind, setKind] = useState("all");
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const changed = useChanged(own);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return own.filter(
      (c) =>
        (!q || c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)) &&
        (severities.length === 0 || severities.includes(c.severity)) &&
        (kind === "all" || c.kind === kind),
    );
  }, [own, query, severities, kind]);

  const columns = useMemo(() => {
    const map = new Map<Column, Card[]>(COLUMNS.map((c) => [c.key, []]));
    for (const card of filtered) map.get(card.column)?.push(card);
    for (const [key, cards] of map) map.set(key, sortColumn(key, cards));
    return map;
  }, [filtered]);

  const filtering = query !== "" || severities.length > 0 || kind !== "all";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2.5 sm:px-5">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="번호나 제목 검색"
            className="h-8 pl-8"
            aria-label="티켓 검색"
          />
        </div>
        <ToggleGroup
          type="multiple"
          variant="outline"
          spacing={0}
          value={severities}
          onValueChange={(v) => setSeverities(v as Severity[])}
          aria-label="심각도 필터"
        >
          {SEVERITIES.map((s) => (
            <ToggleGroupItem key={s.key} value={s.key} className="px-2.5 text-xs">
              {s.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-32" aria-label="종류 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">모든 종류</SelectItem>
            {KINDS.map((k) => (
              <SelectItem key={k.key} value={k.key}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setSeverities([]);
              setKind("all");
            }}
          >
            <X />
            필터 지우기
          </Button>
        )}
        <BoardStats cards={own} />
      </div>

      <LayoutGroup id={track}>
        <motion.div
          variants={columnsIn}
          initial={reduce ? false : "hidden"}
          animate="show"
          className="thin-scroll flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:snap-none sm:px-5"
        >
          {COLUMNS.map(({ key, label: base }) => {
            const label = key === "exploring" ? text.exploring : base;
            const all = columns.get(key) ?? [];
            const cards = key === "done" ? all.slice(0, doneShown) : all;
            const count = key === "exploring" ? (exploring ? 1 : 0) : all.length;
            return (
              <motion.section
                variants={columnIn}
                key={key}
                aria-label={label}
                className="flex w-[85vw] max-w-[340px] min-w-0 shrink-0 snap-start flex-col rounded-2xl bg-board ring-1 ring-border/60 sm:w-auto sm:max-w-none sm:min-w-[272px] sm:flex-1"
              >
                <header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      key === "exploring" && "bg-sky-500",
                      key === "awaiting" && "bg-amber-500",
                      key === "working" && "bg-violet-500",
                      key === "final" && "bg-emerald-500",
                      key === "done" && "bg-foreground/30",
                    )}
                  />
                  <h2 className="text-[13px] font-semibold">{label}</h2>
                  <span className="rounded-full bg-foreground/8 px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                    {count}
                  </span>
                </header>
                <motion.div layoutScroll className="thin-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-3">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {key === "exploring" && exploring && (
                      <ExploringCard key={`explore:${exploring.task}:${exploring.title}`} exploring={exploring} />
                    )}
                    {cards.map((card) => (
                      <TicketCard key={card.id} card={card} flash={changed.has(card.id)} onOpen={open} />
                    ))}
                  </AnimatePresence>
                  {count === 0 && (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                      {key === "exploring" ? text.idle : filtering ? "조건에 맞는 티켓이 없습니다" : text.empty}
                    </p>
                  )}
                  {key === "done" && all.length > cards.length && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-muted-foreground"
                      onClick={() => setDoneShown((n) => n + DONE_PAGE)}
                    >
                      더 보기 ({all.length - cards.length}건 남음)
                    </Button>
                  )}
                </motion.div>
              </motion.section>
            );
          })}
        </motion.div>
      </LayoutGroup>
    </div>
  );
}
