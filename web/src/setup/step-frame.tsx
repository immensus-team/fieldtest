import { AnimatePresence, motion, usePresenceData } from "motion/react";
import { forwardRef, type ReactNode } from "react";

const slide = { type: "spring", visualDuration: 0.3, bounce: 0 } as const;

// One step's page. It reads the direction from AnimatePresence, so a step that leaves goes the way the
// person moved even after the new step id arrived: forward pages come in from the right.
const Page = forwardRef<HTMLDivElement, { children: ReactNode }>(function Page({ children }, ref) {
  const direction = (usePresenceData() as number | undefined) ?? 1;
  return (
    <motion.div
      ref={ref}
      initial={{ x: 24 * direction, opacity: 0 }}
      animate={{ x: 0, opacity: 1, transition: slide }}
      exit={{ x: -24 * direction, opacity: 0, transition: slide }}
    >
      {children}
    </motion.div>
  );
});

// The card around the steps: its height follows each step's content (layout), and steps slide in and
// out by direction (popLayout, so the next step takes the place at once).
export function StepFrame({ stepKey, direction, children }: { stepKey: string; direction: number; children: ReactNode }) {
  return (
    <motion.div layout transition={slide} className="relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm sm:p-7">
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <Page key={stepKey}>{children}</Page>
      </AnimatePresence>
    </motion.div>
  );
}
