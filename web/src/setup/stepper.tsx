import { AnimatePresence, motion } from "motion/react";
import type { SetupState, StepId } from "@/api/setup";
import { cn } from "@/lib/utils";
import { CheckDraw } from "./motion-bits";

export const STEP_LABELS: Record<StepId, string> = {
  server: "서버 점검",
  github: "GitHub",
  repo: "검사할 레포",
  claude: "Claude",
  codex: "Codex",
  slack: "Slack",
  bootstrap: "실행 지침 만들기",
  recipe: "실행 지침 확인",
  start: "시작",
};

// One line under each step's name: what is done or what it waits for.
export function stepNote(id: StepId, setup: SetupState): string {
  const step = setup.steps[id];
  const info = step.info as Record<string, string>;
  if (step.done) {
    if (id === "github" && info.login) return `완료 · ${info.login}`;
    if (id === "repo" && info.repo) return `완료 · ${info.repo}`;
    return "완료";
  }
  if (id === setup.current) return "진행 중";
  return "대기";
}

const spring = { type: "spring", visualDuration: 0.5, bounce: 0 } as const;

// Vertical list of steps. The highlight behind the step on screen moves between items (layoutId), a
// number turns into a drawn check when its step is done, and the line between steps fills as they finish.
export function Stepper({ setup, viewing, onPick }: { setup: SetupState; viewing: StepId; onPick: (id: StepId) => void }) {
  return (
    <ol className="relative flex flex-col gap-1">
      {setup.order.map((id, i) => {
        const done = setup.steps[id].done;
        const reachable = done || id === setup.current;
        const here = id === viewing;
        return (
          <li key={id} className="relative">
            {i < setup.order.length - 1 && (
              <span className="absolute top-9 left-[23px] h-[calc(100%-1.75rem)] w-px bg-border" aria-hidden="true">
                <motion.span className="absolute inset-0 origin-top bg-ok" initial={false} animate={{ scaleY: done ? 1 : 0 }} transition={spring} />
              </span>
            )}
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onPick(id)}
              aria-current={here ? "step" : undefined}
              className="relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
            >
              {here && <motion.span layoutId="setup-current-step" className="absolute inset-0 rounded-xl bg-muted" transition={spring} />}
              <span
                className={cn(
                  "relative grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                  done ? "border-ok/40 bg-ok/10 text-ok" : here ? "border-foreground/30 bg-background" : "bg-background text-muted-foreground",
                )}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {done ? (
                    <motion.span key="check" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }}>
                      <CheckDraw />
                    </motion.span>
                  ) : (
                    <motion.span key="n" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}>
                      {i + 1}
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <span className="relative min-w-0">
                <span className={cn("block truncate text-sm font-medium", !reachable && "text-muted-foreground")}>{STEP_LABELS[id]}</span>
                <span className="block truncate text-xs text-muted-foreground">{stepNote(id, setup)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// Narrow screens: "3/9 · Claude" over a bar that fills as steps finish.
export function StepProgress({ setup, viewing }: { setup: SetupState; viewing: StepId }) {
  const doneCount = setup.order.filter((id) => setup.steps[id].done).length;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-semibold tabular-nums">
          {setup.order.indexOf(viewing) + 1}/{setup.order.length}
        </span>
        <span className="truncate text-muted-foreground">{STEP_LABELS[viewing]}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <motion.div className="h-full origin-left rounded-full bg-ok" initial={false} animate={{ scaleX: doneCount / setup.order.length }} transition={spring} />
      </div>
    </div>
  );
}
