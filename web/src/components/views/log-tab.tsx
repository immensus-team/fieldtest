import { AnimatePresence, motion } from "motion/react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { CommandsView } from "./commands-view";
import { ExploreView } from "./explore-view";
import { LogsView } from "./logs-view";

export type LogSub = "commands" | "explore" | "logs";

export const LOG_SUBS: { key: LogSub; label: string }[] = [
  { key: "commands", label: "명령" },
  { key: "explore", label: "탐색" },
  { key: "logs", label: "로그" },
];

// 명령, 탐색 and 로그 under one tab. The selected pill slides between them (shared layout) and the
// content cross-fades, so switching reads as one surface rather than a new page.
export function LogTab({ sub, onSub }: { sub: LogSub; onSub: (sub: LogSub) => void }) {
  return (
    <div className={cn("flex min-h-0 flex-col gap-3", sub === "logs" && "h-full")}>
      <Tabs value={sub} onValueChange={(v) => onSub(v as LogSub)}>
        <TabsList aria-label="로그 종류">
          {LOG_SUBS.map((s) => (
            <TabsTrigger
              key={s.key}
              value={s.key}
              className="px-3 data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
            >
              {sub === s.key && (
                <motion.span
                  layoutId="log-sub"
                  aria-hidden="true"
                  className="absolute inset-0 rounded-md bg-background shadow-sm dark:bg-input/40"
                  transition={{ type: "spring", visualDuration: 0.25, bounce: 0 }}
                />
              )}
              <span className="relative">{s.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={sub}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: "easeOut" } }}
          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
          className={cn("min-h-0", sub === "logs" && "flex flex-1 flex-col")}
        >
          {sub === "commands" && <CommandsView />}
          {sub === "explore" && <ExploreView />}
          {sub === "logs" && <LogsView />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
