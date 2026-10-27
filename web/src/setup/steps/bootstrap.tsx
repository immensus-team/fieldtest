import { CircleX } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useBootstrap, useSaveSecrets, useStartBootstrap } from "@/api/setup";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { CheckDraw, PulseDot } from "../motion-bits";
import { DoneNote, Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

const STAGES = [
  ["session", "레포를 읽고 레시피 쓰기"],
  ["install", "설치"],
  ["services", "서비스 기동과 시드"],
  ["screens", "화면 접속"],
  ["checks", "검사 명령과 e2e"],
] as const;

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

  useEffect(() => {
    if (st.stage === "ready" && !running) onDone();
  }, [st.stage, running, onDone]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [status.data?.log]);

  if (done) {
    return (
      <StepBody headingRef={headingRef} title="레시피 만들기" lead="에이전트가 레포를 읽고 앱을 띄우는 방법을 정해 직접 검증했습니다.">
        <Part>
          <DoneNote onRedo={() => reopen("bootstrap")}>레시피 초안이 검증을 통과했습니다.</DoneNote>
        </Part>
      </StepBody>
    );
  }
  const started = running || (st.stage && st.stage !== "ready");
  return (
    <StepBody headingRef={headingRef} title="레시피 만들기" lead="에이전트가 레포를 읽고 설치·실행·로그인·검사 방법을 레시피로 쓴 뒤, 실행기가 그대로 돌려 봅니다. 실패하면 오류를 돌려줘 최대 5번 고칩니다.">
      {started && (
        <Part>
          <ol className="flex flex-col gap-2.5" aria-live="polite">
            {STAGES.map(([id, label], i) => {
              const state = i < at ? "done" : i === at && running ? "now" : i === at && failed ? "failed" : "wait";
              return (
                <motion.li key={id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="flex items-center gap-3 text-sm">
                  <span className={cn("grid size-6 place-items-center rounded-full border", state === "done" && "border-ok/40 bg-ok/10 text-ok", state === "failed" && "border-destructive/40 text-destructive")}>
                    {state === "done" ? <CheckDraw /> : state === "now" ? <PulseDot /> : state === "failed" ? <CircleX className="size-3.5" /> : null}
                  </span>
                  <span className={cn(state === "wait" && "text-muted-foreground")}>{label}</span>
                  {state === "now" && id === "session" && st.attempt ? <span className="text-xs text-muted-foreground">시도 {st.attempt}/5</span> : null}
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
      <StepError title="레시피를 만들지 못했습니다" error={failed && !needKeys ? st.error : start.error?.message} />
      {!running && !needKeys && (
        <Part>
          <div>
            <StatusButton state={start.isPending ? "working" : "idle"} idle={failed ? "다시 만들기" : "레시피 만들기 시작"} working="시작하는 중" onClick={() => start.mutate(undefined)} />
          </div>
        </Part>
      )}
    </StepBody>
  );
}
