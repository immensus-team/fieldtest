import { ChevronRight, OctagonAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Overview } from "@/api/types";
import { useOpenTicket } from "@/lib/url-state";

export function AlertBanner({ alerts }: { alerts: Overview["alerts"] }) {
  const [, open] = useOpenTicket();
  return (
    <AnimatePresence initial={false}>
      {alerts.length > 0 && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden border-b border-red-500/25 bg-red-500/8 dark:bg-red-500/12"
          role="alert"
        >
          <ul className="space-y-0.5 px-4 py-2 sm:px-5">
            {alerts.map((alert, i) => (
              <li key={`${alert.ticket ?? "-"}:${i}`}>
                {alert.ticket ? (
                  <button
                    type="button"
                    onClick={() => open(alert.ticket)}
                    className="group flex w-full items-start gap-2 rounded-md py-0.5 text-left text-sm text-red-700 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200"
                  >
                    <OctagonAlert className="mt-0.5 size-4 shrink-0" />
                    <span className="font-mono text-[13px] font-semibold">{alert.ticket}</span>
                    <span className="min-w-0 flex-1">{alert.text}</span>
                    <ChevronRight className="mt-0.5 size-4 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5" />
                  </button>
                ) : (
                  <div className="flex items-start gap-2 py-0.5 text-sm text-red-700 dark:text-red-300">
                    <OctagonAlert className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1">{alert.text}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
