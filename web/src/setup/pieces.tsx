import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckDraw, PulseDot, stagger } from "./motion-bits";

// Title, text and the step's content, entering one after another.
export function StepBody({ title, lead, headingRef, children }: { title: string; lead: ReactNode; headingRef: React.Ref<HTMLHeadingElement>; children: ReactNode }) {
  return (
    <motion.div variants={stagger.parent} initial="hidden" animate="show" className="flex flex-col gap-5">
      <motion.div variants={stagger.child} className="flex flex-col gap-1.5">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
          {title}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{lead}</p>
      </motion.div>
      {children}
    </motion.div>
  );
}

export function Part({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={stagger.child} className={cn("flex flex-col gap-3", className)}>
      {children}
    </motion.div>
  );
}

// Idle → working (spinner) → done (drawn check). The label swaps in place and the width follows it.
export function StatusButton({
  state,
  idle,
  working,
  done = "완료",
  onClick,
  disabled,
  variant = "default",
  type = "button",
}: {
  type?: "button" | "submit";
  state: "idle" | "working" | "done";
  idle: string;
  working: string;
  done?: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "outline";
}) {
  const reduce = useReducedMotion();
  const label = { idle, working, done }[state];
  return (
    <motion.div layout="size" className="inline-flex" transition={{ duration: 0.15 }}>
      {/* Busy or done is aria-disabled, not disabled: a disabled button drops the keyboard focus. */}
      <Button
        type={type}
        size="lg"
        variant={variant}
        onClick={(e) => (state === "idle" ? onClick?.() : e.preventDefault())}
        disabled={disabled}
        aria-disabled={state !== "idle" || undefined}
        className="min-w-28 aria-disabled:opacity-70"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={state} className="inline-flex items-center gap-1.5" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
            {state === "working" && <Loader2 className={reduce ? "" : "animate-spin"} />}
            {state === "done" && <CheckDraw className="text-ok" />}
            {label}
          </motion.span>
        </AnimatePresence>
      </Button>
    </motion.div>
  );
}

// An error that opens in place (height and opacity) when it appears.
export function StepError({ title, error }: { title: string; error: string | null | undefined }) {
  return (
    <AnimatePresence initial={false}>
      {error && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="break-words whitespace-pre-wrap">{error}</AlertDescription>
          </Alert>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return { copied, copy };
}

export function CopyButton({ text, label = "복사" }: { text: string; label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => copy(text)} aria-label={`${label}: ${copied ? "복사됨" : ""}`}>
      {copied ? <Check className="text-ok" /> : <Copy />}
      {copied ? "복사됨" : label}
    </Button>
  );
}

// A device code in large monospaced cells, each appearing in turn, with its page and a copy button.
export function DeviceCode({ url, code, waiting }: { url: string; code: string; waiting: string }) {
  const reduce = useReducedMotion();
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-muted/40 p-4">
      <div className="flex flex-wrap items-center gap-1 sm:gap-1.5" aria-label={`코드 ${code}`}>
        {[...code].map((ch, i) => (
          <motion.span
            key={`${i}-${ch}`}
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03, duration: 0.2, ease: "easeOut" }}
            className={cn("grid h-10 w-[1.6rem] place-items-center rounded-lg font-mono text-lg font-semibold sm:h-11 sm:w-9 sm:text-xl", ch === "-" ? "w-3 bg-transparent text-muted-foreground sm:w-4" : "border bg-background")}
          >
            {ch}
          </motion.span>
        ))}
        <span className="basis-full sm:basis-auto sm:pl-1">
          <CopyButton text={code} label="코드 복사" />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="lg">
          <a href={url} target="_blank" rel="noreferrer">
            승인 페이지 열기
            <ExternalLink />
          </a>
        </Button>
        <span className="break-all font-mono text-xs text-muted-foreground">{url}</span>
      </div>
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <PulseDot />
        {waiting}
      </p>
    </div>
  );
}

// A done step's summary with a way to do it again.
export function DoneNote({ children, onRedo, redo = "다시 하기" }: { children: ReactNode; onRedo?: () => void; redo?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ok/30 bg-ok/5 p-4">
      <p className="flex items-center gap-2 text-sm" aria-live="polite">
        <span className="grid size-6 place-items-center rounded-full bg-ok/15 text-ok">
          <CheckDraw />
        </span>
        {children}
      </p>
      {onRedo && (
        <Button type="button" variant="ghost" size="sm" onClick={onRedo}>
          {redo}
        </Button>
      )}
    </div>
  );
}
