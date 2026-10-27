import { ArrowDown } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { LogLine } from "@/api/types";
import { Button } from "@/components/ui/button";
import { clockTime } from "@/lib/time";
import { useOpenTicket } from "@/lib/url-state";
import { cn } from "@/lib/utils";

// Lines that report a failure, not every line that mentions one.
const FAIL = /(실패:|오류:|\berror\b|"result":"[a-z-]*fail)/i;
const ID = /(QA-\d{4})/g;

function Text({ text }: { text: string }) {
  const [, open] = useOpenTicket();
  const parts = text.split(ID);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <button
            key={i}
            type="button"
            onClick={() => open(part)}
            className="font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
          >
            {part}
          </button>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

// Newest line at the bottom; follows new lines unless the person has scrolled up to read.
export function LogView({
  lines,
  showSource = false,
  className,
}: {
  lines: LogLine[];
  showSource?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="thin-scroll h-full overflow-auto rounded-lg border bg-muted/40 py-2 font-mono text-[12px] leading-[1.6]"
      >
        {lines.length === 0 ? (
          <p className="px-3 py-6 text-center font-sans text-sm text-muted-foreground">로그가 없습니다</p>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-3 px-3 hover:bg-foreground/5",
                FAIL.test(line.text) && "bg-red-500/6 text-red-700 dark:text-red-300",
              )}
            >
              <span className="shrink-0 text-muted-foreground tabular-nums select-none">{clockTime(line.at)}</span>
              {showSource && <span className="w-10 shrink-0 text-muted-foreground select-none">{line.source}</span>}
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                <Text text={line.text} />
              </span>
            </div>
          ))
        )}
      </div>
      {!follow && (
        <Button
          size="xs"
          variant="secondary"
          className="absolute right-3 bottom-3 shadow-md"
          onClick={() => setFollow(true)}
        >
          <ArrowDown />
          최신으로
        </Button>
      )}
    </div>
  );
}
