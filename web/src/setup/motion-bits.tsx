import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

// A check mark that draws itself (pathLength 0 → 1). Reduced motion shows it drawn.
export function CheckDraw({ className, delay = 0 }: { className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("size-4", className)}>
      <motion.path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: reduce ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ type: "spring", visualDuration: 0.4, bounce: 0, delay }}
      />
    </svg>
  );
}

// Waiting on someone else (an approval, a DM): a dot whose opacity breathes. Still under reduced motion.
export function PulseDot({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={cn("relative inline-flex size-2.5", className)} aria-hidden="true">
      <motion.span
        className="absolute inset-0 rounded-full bg-glow"
        animate={reduce ? { opacity: 0.8 } : { opacity: [0.35, 1, 0.35] }}
        transition={reduce ? undefined : { duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
      />
    </span>
  );
}

// Shakes its child once whenever `token` changes (a failed check). Not under reduced motion.
export function Shake({ token, children, className }: { token: unknown; children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      key={String(token ?? "")}
      className={className}
      initial={false}
      animate={reduce || !token ? { x: 0 } : { x: [0, -6, 6, -4, 4, 0] }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

// Children enter one after another: title, text, inputs.
export const stagger = {
  parent: { hidden: {}, show: { transition: { staggerChildren: 0.04 } } },
  child: { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } } },
} as const;
