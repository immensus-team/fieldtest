import { motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useEffect, useId } from "react";
import { cn } from "@/lib/utils";

// Counts toward each new value. The spring writes the text straight to the DOM, so a 5-second refresh
// doesn't re-render the card; with reduced motion the number just changes.
export function AnimatedNumber({ value, format, className }: { value: number; format: (n: number) => string; className?: string }) {
  const reduce = useReducedMotion();
  const spring = useSpring(reduce ? value : 0, { visualDuration: 0.6, bounce: 0 });
  useEffect(() => {
    if (reduce) spring.jump(value);
    else spring.set(value);
  }, [spring, value, reduce]);
  const text = useTransform(spring, format);
  return <motion.span className={cn("tabular-nums", className)}>{text}</motion.span>;
}

// A usage bar whose fill slides to the new value.
export function Meter({ percent, className, label }: { percent: number; className?: string; label: string }) {
  const reduce = useReducedMotion();
  const width = `${Math.min(100, Math.max(0, percent))}%`;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <motion.div
        className={cn("h-full rounded-full", className)}
        initial={reduce ? false : { width: 0 }}
        animate={{ width }}
        transition={{ type: "spring", visualDuration: 0.5, bounce: 0 }}
      />
    </div>
  );
}

// Recent samples as a line with a soft fill. null is a gap (a failed or missed sample), never zero.
// It draws in from the left once: a clip that widens, since pathLength dashes break under a
// non-scaling stroke.
export function Sparkline({
  values,
  max,
  className,
  label,
}: {
  values: (number | null)[];
  max: number;
  className?: string;
  label: string;
}) {
  const reduce = useReducedMotion();
  const clip = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const n = values.length;
  const x = (i: number) => (n <= 1 ? 100 : (i / (n - 1)) * 100);
  const y = (v: number) => 30 - (Math.min(v, max) / max) * 28;
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ i, v });
  });
  if (run.length) runs.push(run);
  const line = runs.map((r) => r.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join("")).join("");
  const area = runs
    .filter((r) => r.length > 1)
    .map((r) => `M${x(r[0].i).toFixed(2)},30${r.map((p) => `L${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join("")}L${x(r[r.length - 1].i).toFixed(2)},30Z`)
    .join("");
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={label} className={cn("h-10 w-full overflow-visible", className)}>
      <defs>
        <clipPath id={clip}>
          <motion.rect x={-1} y={-2} height={36} initial={reduce ? false : { width: 0 }} animate={{ width: 102 }} transition={{ duration: 0.8, ease: "easeOut" }} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <path d={area} fill="currentColor" opacity={0.12} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}
