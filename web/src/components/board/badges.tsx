import { AlertTriangle, Bot, ExternalLink, GitMerge, Layers, OctagonAlert, Repeat } from "lucide-react";
import type { Blocked, Card, Severity, Track } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { kindLabel, SEVERITY_CLASS, severityLabel } from "@/lib/labels";
import { relative, useNow } from "@/lib/time";
import { useOpenTicket } from "@/lib/url-state";
import { cn } from "@/lib/utils";

const chip =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset";

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cn(chip, SEVERITY_CLASS[severity])}>{severityLabel(severity)}</span>;
}

export function KindBadge({ kind }: { kind: string | null }) {
  const label = kindLabel(kind);
  if (!label) return null;
  return (
    <span
      className={cn(
        chip,
        kind === "judgment"
          ? "bg-violet-500/12 text-violet-700 ring-violet-500/25 dark:text-violet-300"
          : "bg-transparent text-muted-foreground ring-border",
      )}
    >
      {label}
    </span>
  );
}

// Only improvements and feature proposals are marked; a defect is the default.
export function TrackBadge({ track, proposal }: { track: Track; proposal?: boolean }) {
  if (proposal) return <span className={cn(chip, "bg-violet-500/12 text-violet-700 ring-violet-500/25 dark:text-violet-300")}>제안</span>;
  if (track !== "improve") return null;
  return <span className={cn(chip, "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:text-sky-300")}>개선</span>;
}

export function AutoMergeBadge() {
  return (
    <span className={cn(chip, "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:text-sky-300")}>
      <GitMerge className="size-3" />
      자동 머지
    </span>
  );
}

// A ticket on the automatic route: no human approval or final review.
export function AutoRouteBadge({ merged }: { merged: boolean }) {
  return (
    <span className={cn(chip, "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:text-sky-300")}>
      <Bot className="size-3" />
      {merged ? "자동 머지됨" : "자동 진행"}
    </span>
  );
}

export function PrChip({ pr }: { pr: NonNullable<Card["pr"]> }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(chip, "bg-transparent font-mono text-foreground/80 ring-border hover:bg-muted hover:text-foreground")}
    >
      #{pr.number}
      <ExternalLink className="size-3 opacity-60" />
    </a>
  );
}

export function GroupChip({ group }: { group: NonNullable<Card["group"]> }) {
  const [, open] = useOpenTicket();
  if (group.role === "group") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(chip, "bg-transparent text-muted-foreground ring-border")}>
            <Layers className="size-3" />
            묶음 {group.members.length}건
          </span>
        </TooltipTrigger>
        <TooltipContent>{group.members.join(", ")}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open(group.id);
      }}
      className={cn(chip, "bg-transparent font-mono text-muted-foreground ring-border hover:bg-muted hover:text-foreground")}
    >
      ↳ {group.id}
    </button>
  );
}

export function BlockedLine({ blocked, clamp = false, className }: { blocked: Blocked; clamp?: boolean; className?: string }) {
  const now = useNow();
  const error = blocked.tone === "error";
  const Icon = error ? OctagonAlert : AlertTriangle;
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs leading-snug",
        error
          ? "bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-300"
          : "bg-amber-500/10 text-amber-800 dark:bg-amber-500/12 dark:text-amber-300",
        className,
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <div className={cn("min-w-0 flex-1", clamp && "line-clamp-3")}>
        {blocked.repeat && (
          <span className="mr-1.5 inline-flex items-center gap-0.5 rounded bg-red-600 px-1 py-px align-[1px] text-[10px] font-semibold text-white dark:bg-red-500">
            <Repeat className="size-2.5" />
            반복 실패 ×{blocked.repeat.count}
          </span>
        )}
        <span className="break-words whitespace-pre-wrap">{blocked.text}</span>
        {blocked.repeat && (
          <span className="ml-1 whitespace-nowrap opacity-75">· 마지막 {relative(blocked.repeat.last, now)}</span>
        )}
      </div>
    </div>
  );
}
