import { Compass } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import type { Card, Exploring } from "@/api/types";
import { cn } from "@/lib/utils";
import {
  AutoMergeBadge,
  AutoRouteBadge,
  BlockedLine,
  GroupChip,
  KindBadge,
  PrChip,
  SeverityBadge,
} from "./badges";
import { ProgressDetail, Stepper } from "./progress";

const enter = { opacity: 0, y: 8, scale: 0.97 };
const shown = { opacity: 1, y: 0, scale: 1 };
const leave = { opacity: 0, scale: 0.96, transition: { duration: 0.15 } };
const layoutSpring = { type: "spring", stiffness: 380, damping: 34, mass: 0.8 } as const;

function Frame({ active, flash, children }: { active: boolean; flash: boolean; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl", active && "glow-frame")}>
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs transition-[box-shadow,border-color]",
          active ? "border-transparent shadow-md" : "hover:border-foreground/20 hover:shadow-sm",
        )}
      >
        {flash && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl bg-glow/15 ring-2 ring-glow ring-inset"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 2.4, ease: "easeOut" }}
          />
        )}
        {children}
      </div>
    </div>
  );
}

export function TicketCard({
  card,
  flash,
  onOpen,
  ref,
}: {
  card: Card;
  flash: boolean;
  onOpen: (id: string) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <motion.div
      ref={ref}
      layout="position"
      layoutId={card.id}
      initial={enter}
      animate={shown}
      exit={leave}
      transition={{ layout: layoutSpring, default: { duration: 0.2 } }}
      role="button"
      tabIndex={0}
      aria-label={`${card.id} ${card.title}`}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(card.id);
        }
      }}
      className="cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Frame active={card.progress.active} flash={flash}>
        <div className="space-y-2.5 p-3">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[11px] font-medium text-muted-foreground">{card.id}</span>
            <SeverityBadge severity={card.severity} />
            <KindBadge kind={card.kind} />
            <span className="ml-auto flex items-center gap-1">
              {card.pr && <PrChip pr={card.pr} />}
            </span>
          </div>
          <h3 className="line-clamp-2 text-[13.5px] leading-snug font-medium text-pretty">{card.title}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "text-xs font-medium",
                card.progress.active ? "text-glow" : "text-foreground/70",
              )}
            >
              {card.stage}
            </span>
            {card.route?.auto || card.autoMerged ? (
              <AutoRouteBadge merged={card.autoMerged} />
            ) : (
              card.autoMerge && <AutoMergeBadge />
            )}
            {card.group && <GroupChip group={card.group} />}
          </div>
          {card.progress.steps.length > 0 && (
            <div className="space-y-2 pt-0.5">
              <Stepper steps={card.progress.steps} active={card.progress.active} />
              <ProgressDetail progress={card.progress} />
            </div>
          )}
          {card.blocked && <BlockedLine blocked={card.blocked} clamp />}
        </div>
      </Frame>
    </motion.div>
  );
}

const EXPLORE_LABEL: Record<Exploring["task"], string> = { 탐색: "자유 탐색", 판정: "탐색 판정", "결함 수정": "발견 수정" };

export function ExploringCard({ exploring, ref }: { exploring: Exploring; ref?: Ref<HTMLDivElement> }) {
  return (
    <motion.div ref={ref} layout initial={enter} animate={shown} exit={leave}>
      <Frame active={exploring.progress.active} flash={false}>
        <div className="space-y-2.5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Compass className="size-3.5" />
            {EXPLORE_LABEL[exploring.task]}
            {exploring.area && <span className="font-mono">{exploring.area}</span>}
          </div>
          <h3 className="text-[13.5px] leading-snug font-medium break-words">{exploring.title}</h3>
          {exploring.progress.steps.length > 0 && (
            <Stepper steps={exploring.progress.steps} active={exploring.progress.active} />
          )}
          <ProgressDetail progress={exploring.progress} />
        </div>
      </Frame>
    </motion.div>
  );
}
