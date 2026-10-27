import { motion } from "motion/react";
import type { Progress, Step } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { elapsed, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";

const spring = { type: "spring", stiffness: 260, damping: 28 } as const;

// How far the line between dots is filled: up to the current (or failed) step, else the last done one.
function reach(steps: Step[]) {
  const live = steps.findIndex((s) => s.state === "current" || s.state === "failed");
  if (live >= 0) return live;
  let last = -1;
  steps.forEach((s, i) => {
    if (s.state === "done") last = i;
  });
  return last;
}

function Dot({ step, size, active }: { step: Step; size: "sm" | "md"; active: boolean }) {
  const box = size === "sm" ? "size-2" : "size-3";
  return (
    <span className={cn("relative flex items-center justify-center", size === "sm" ? "size-3" : "size-4")}>
      {step.state === "current" && active && (
        <motion.span
          className={cn("absolute rounded-full bg-glow", box)}
          initial={{ scale: 1, opacity: 0.55 }}
          animate={{ scale: 2.6, opacity: 0 }}
          transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: "easeOut" }}
        />
      )}
      <motion.span
        key={step.state}
        initial={{ scale: 0.4 }}
        animate={{ scale: 1 }}
        transition={spring}
        className={cn(
          "relative rounded-full border-[1.5px]",
          box,
          step.state === "done" && "border-foreground/70 bg-foreground/70",
          step.state === "current" && "border-glow bg-glow ring-[3px] ring-glow/25",
          step.state === "failed" && "border-red-500 bg-red-500 ring-[3px] ring-red-500/20",
          step.state === "todo" && "border-foreground/25 bg-background",
        )}
      />
    </span>
  );
}

export function Stepper({
  steps,
  active = false,
  size = "sm",
  labels = false,
}: {
  steps: Step[];
  active?: boolean;
  size?: "sm" | "md";
  labels?: boolean;
}) {
  if (steps.length === 0) return null;
  const at = reach(steps);
  const pct = steps.length > 1 ? (Math.max(0, at) / (steps.length - 1)) * 100 : 0;
  const failed = steps[at]?.state === "failed";
  const inset = size === "sm" ? "6px" : "8px";

  return (
    <div className="w-full">
      <div className="relative flex items-center justify-between">
        <div
          className="absolute top-1/2 h-px -translate-y-1/2 bg-foreground/15"
          style={{ left: inset, right: inset }}
        />
        <div className="absolute top-1/2 h-px -translate-y-1/2" style={{ left: inset, right: inset }}>
          <motion.div
            className={cn("h-full", failed ? "bg-red-500/70" : "bg-foreground/60")}
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={spring}
          />
        </div>
        {steps.map((step) => (
          <Tooltip key={step.key}>
            <TooltipTrigger asChild>
              <span className="relative z-10">
                <Dot step={step} size={size} active={active} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {step.label}
              {step.state === "done" && " · 완료"}
              {step.state === "current" && " · 진행 중"}
              {step.state === "failed" && " · 실패"}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {labels && (
        <div className="relative mt-1.5 hidden h-4 sm:block" style={{ marginInline: inset }}>
          {steps.map((step, i) => (
            <span
              key={step.key}
              className={cn(
                "absolute top-0 text-[11px] leading-tight whitespace-nowrap",
                i === 0 ? "translate-x-[-8px]" : i === steps.length - 1 ? "translate-x-[calc(-100%+8px)]" : "-translate-x-1/2",
                step.state === "current" ? "font-semibold text-foreground" : "text-muted-foreground",
                step.state === "failed" && "font-semibold text-red-600 dark:text-red-400",
              )}
              style={{ left: `${(i / (steps.length - 1)) * 100}%` }}
            >
              {step.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Timer({ since }: { since: string }) {
  const now = useNow();
  return <span className="tabular-nums">{elapsed(since, now)}</span>;
}

export function ProgressDetail({ progress, className }: { progress: Progress; className?: string }) {
  if (!progress.detail && !progress.since && progress.ratio === null) return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      {(progress.detail || progress.since) && (
        <p
          className={cn(
            "text-xs leading-snug",
            progress.active ? "text-foreground/85" : "text-muted-foreground",
          )}
        >
          {progress.detail}
          {progress.detail && progress.since && <span className="text-muted-foreground"> · </span>}
          {progress.since && (
            <span className="text-muted-foreground">
              <Timer since={progress.since} />
            </span>
          )}
        </p>
      )}
      {progress.ratio !== null && <RatioBar ratio={progress.ratio} />}
    </div>
  );
}

export function RatioBar({ ratio, tone = "glow" }: { ratio: number; tone?: "glow" | "ok" }) {
  const pct = Math.min(1, Math.max(0, ratio)) * 100;
  return (
    <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
      <motion.div
        className={cn(
          "h-full rounded-full",
          tone === "ok" || pct >= 100 ? "bg-emerald-500" : "bg-gradient-to-r from-glow to-glow-2",
        )}
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={spring}
      />
    </div>
  );
}
