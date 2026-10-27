import { Lock, Search } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { useChooseRepo, useRepos } from "@/api/setup";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DoneNote, Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

export function RepoStep({ setup, headingRef, onDone, reopen }: StepProps) {
  const done = setup.steps.repo.done;
  const repos = useRepos(!done);
  const choose = useChooseRepo();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useMemo(() => (repos.data ?? []).filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase())), [repos.data, query]);

  if (done) {
    return (
      <StepBody headingRef={headingRef} title="검사할 레포" lead="에이전트가 탐색하고 고칠 레포입니다. 바꾸면 레시피를 다시 만듭니다.">
        <Part>
          <DoneNote onRedo={() => reopen("repo")}>
            <span className="font-mono">{String(setup.steps.repo.info.repo)}</span> ({String(setup.steps.repo.info.base)} branch)
          </DoneNote>
        </Part>
      </StepBody>
    );
  }
  return (
    <StepBody headingRef={headingRef} title="검사할 레포" lead="로그인한 계정이 push할 수 있는 레포를 하나 고릅니다. 고르면 서버가 미러와 에이전트용 clone을 만듭니다.">
      <Part>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="레포 이름으로 찾기" aria-label="레포 이름으로 찾기" className="h-9 pl-9" />
        </div>
        <ScrollArea className="h-72 rounded-xl border">
          {repos.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : (
            <ul role="radiogroup" aria-label="레포" className="flex flex-col p-1.5">
              {shown.map((r, i) => (
                <motion.li key={r.name} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i, 12) * 0.02 }}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={picked === r.name}
                    disabled={!r.push}
                    onClick={() => setPicked(r.name)}
                    className={cn(
                      "relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                      picked === r.name ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    {picked === r.name && <motion.span layoutId="repo-picked" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-foreground" />}
                    <span className="min-w-0 flex-1 truncate font-mono">{r.name}</span>
                    {r.private && <Lock className="size-3.5 text-muted-foreground" aria-label="비공개" />}
                    {!r.push && <Badge variant="outline">push 권한 없음</Badge>}
                  </button>
                </motion.li>
              ))}
              {!shown.length && <li className="p-4 text-sm text-muted-foreground">맞는 레포가 없습니다.</li>}
            </ul>
          )}
        </ScrollArea>
      </Part>
      <StepError title="레포를 정하지 못했습니다" error={repos.error?.message ?? choose.error?.message} />
      <Part>
        <div>
          <StatusButton
            state={choose.isPending ? "working" : choose.isSuccess ? "done" : "idle"}
            idle="이 레포로 정하기"
            working="미러와 clone 준비 중"
            disabled={!picked}
            onClick={() => picked && choose.mutate(picked, { onSuccess: onDone })}
          />
        </div>
      </Part>
    </StepBody>
  );
}
