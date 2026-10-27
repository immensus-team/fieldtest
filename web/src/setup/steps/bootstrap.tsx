import { CircleX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useBootstrap, useSaveSecrets, useStartBootstrap } from "@/api/setup";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { formatDuration, msOf, relative, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { CheckDraw, PulseDot } from "../motion-bits";
import { DoneNote, Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

const STAGES = [
  ["session", "레포를 읽고 실행 지침 쓰기"],
  ["install", "설치"],
  ["services", "서비스 기동과 시드"],
  ["screens", "화면 접속"],
  ["checks", "검사 명령과 e2e"],
] as const;

// The runner's limits (lib/bootstrap.mjs MAX_BOOTSTRAP_FIXES, BOOTSTRAP_MS).
const MAX_ATTEMPTS = 5;
const LIMIT_MIN = 120;

const order = (stage?: string) => {
  if (stage === "ready") return STAGES.length;
  const i = STAGES.findIndex(([id]) => id === (stage === "seed" || stage === "start" ? "services" : stage));
  return i === -1 ? 0 : i;
};

export function BootstrapStep({ setup, headingRef, onDone, reopen }: StepProps) {
  const done = setup.steps.bootstrap.done;
  const start = useStartBootstrap();
  const status = useBootstrap();
  const saveSecrets = useSaveSecrets();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const logRef = useRef<HTMLPreElement>(null);
  const st = status.data?.state ?? {};
  const running = status.data?.running ?? false;
  const failed = !running && st.stage === "failed";
  const at = order(failed ? (st.failedStage ?? undefined) : st.stage);
  const needKeys = failed && (st.realKeys?.length ?? 0) > 0;
  const now = useNow();
  // A finished run stops its clock at its last update.
  const end = running ? now : (msOf(st.at) ?? now);
  const since = (iso?: string) => {
    const ms = msOf(iso);
    return ms === null ? null : formatDuration(end - ms);
  };
  // Stages done, and half of the one running: the session alone can take half an hour.
  const percent = st.stage === "ready" ? 100 : ((at + (running ? 0.5 : 0)) / STAGES.length) * 100;

  useEffect(() => {
    if (st.stage === "ready" && !running) onDone();
  }, [st.stage, running, onDone]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [status.data?.log]);

  if (done) {
    return (
      <StepBody headingRef={headingRef} title="실행 지침 만들기" lead="에이전트가 레포를 읽고 앱을 띄우는 방법을 정해 직접 검증했습니다.">
        <Part>
          <DoneNote onRedo={() => reopen("bootstrap")}>실행 지침 초안이 검증을 통과했습니다.</DoneNote>
        </Part>
      </StepBody>
    );
  }
  const started = running || (st.stage && st.stage !== "ready");
  return (
    <StepBody headingRef={headingRef} title="실행 지침 만들기" lead="에이전트가 레포를 읽고 설치·실행·로그인·검사 방법을 실행 지침으로 쓴 뒤, 실행기가 그대로 돌려 봅니다. 실패하면 오류를 돌려줘 최대 5번 고칩니다.">
      {started && (
        <Part>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">
                단계 {Math.min(at + 1, STAGES.length)}/{STAGES.length}
                {st.attempt ? <span className="ml-2 font-normal text-muted-foreground">시도 {st.attempt}/{MAX_ATTEMPTS}</span> : null}
              </span>
              {st.startedAt && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  경과 {since(st.startedAt)} · 최대 {LIMIT_MIN}분
                </span>
              )}
            </div>
            <Progress value={percent} aria-label="실행 지침 만들기 진행도" className={cn("h-1.5", failed && "[&>[data-slot=progress-indicator]]:bg-destructive")} />
          </div>
          <ol className="flex flex-col gap-2.5" aria-live="polite">
            {STAGES.map(([id, label], i) => {
              const state = i < at ? "done" : i === at && running ? "now" : i === at && failed ? "failed" : "wait";
              return (
                <motion.li key={id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="flex flex-col gap-1 text-sm">
                  <div className="flex items-center gap-3">
                    <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border", state === "done" && "border-ok/40 bg-ok/10 text-ok", state === "failed" && "border-destructive/40 text-destructive")}>
                      {state === "done" ? <CheckDraw /> : state === "now" ? <PulseDot /> : state === "failed" ? <CircleX className="size-3.5" /> : null}
                    </span>
                    <span className={cn(state === "wait" && "text-muted-foreground")}>{label}</span>
                    {state === "now" && st.stageAt ? <span className="ml-auto text-xs text-muted-foreground tabular-nums">{since(st.stageAt)}</span> : null}
                  </div>
                  {state === "now" && (
                    <AnimatePresence mode="wait" initial={false}>
                      {st.activity ? (
                        <motion.p
                          key={st.activity.text}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.18 }}
                          className="ml-9 flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground"
                          title={st.activity.text}
                        >
                          <span className="min-w-0 truncate font-mono">{st.activity.text}</span>
                          <span className="shrink-0">{relative(st.activity.at, now)}</span>
                        </motion.p>
                      ) : id === "session" ? (
                        <motion.p key="reading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="ml-9 text-xs text-muted-foreground">
                          세션을 시작하는 중
                        </motion.p>
                      ) : null}
                    </AnimatePresence>
                  )}
                </motion.li>
              );
            })}
          </ol>
          {status.data?.log && (
            <pre ref={logRef} className="thin-scroll max-h-56 overflow-auto rounded-xl border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {status.data.log.split("\n").slice(-80).join("\n")}
            </pre>
          )}
        </Part>
      )}
      {needKeys && (
        <Part>
          <form
            className="flex flex-col gap-3 rounded-xl border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveSecrets.mutate(keys, { onSuccess: () => start.mutate(undefined) });
            }}
          >
            <p className="text-sm">가짜 값으로는 앱이 뜨지 않아 실제 키가 필요합니다. 넣은 키는 에이전트가 앱을 띄울 때 씁니다. 비용이 나가거나 외부로 데이터가 갈 수 있습니다.</p>
            {st.realKeys?.map((k) => (
              <div key={k.name} className="flex flex-col gap-1.5">
                <Label htmlFor={`key-${k.name}`} className="font-mono">
                  {k.name}
                </Label>
                <Input id={`key-${k.name}`} type="password" autoComplete="off" value={keys[k.name] ?? ""} onChange={(e) => setKeys((v) => ({ ...v, [k.name]: e.target.value }))} className="h-9 font-mono" />
                <span className="text-xs text-muted-foreground">{k.why}</span>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <StatusButton type="submit" state={saveSecrets.isPending || start.isPending ? "working" : "idle"} idle="키 저장하고 다시 만들기" working="저장 중" />
              <StatusButton
                variant="outline"
                state={start.isPending ? "working" : "idle"}
                idle="키 없이 계속"
                working="시작하는 중"
                onClick={() => start.mutate({ skipKeys: st.realKeys?.map((k) => k.name) ?? [] })}
              />
            </div>
            <p className="text-xs text-muted-foreground">키 없이 계속하면 그 키가 필요한 기능은 mock으로 처리하고 탐색합니다.</p>
          </form>
        </Part>
      )}
      <StepError title="실행 지침을 만들지 못했습니다" error={failed && !needKeys ? st.error : start.error?.message} />
      {!running && !needKeys && (
        <Part>
          <div>
            <StatusButton state={start.isPending ? "working" : "idle"} idle={failed ? "다시 만들기" : "실행 지침 만들기 시작"} working="시작하는 중" onClick={() => start.mutate(undefined)} />
          </div>
        </Part>
      )}
    </StepBody>
  );
}
