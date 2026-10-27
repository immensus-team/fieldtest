import { CircleX } from "lucide-react";
import { motion } from "motion/react";
import { useServerCheck } from "@/api/setup";
import { CheckDraw } from "../motion-bits";
import { DoneNote, Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

export function ServerStep({ setup, headingRef, onDone, reopen }: StepProps) {
  const check = useServerCheck();
  const done = setup.steps.server.done;
  const checks = check.data?.checks ?? (setup.steps.server.info.checks as { name: string; ok: boolean; detail: string }[] | undefined);
  const failed = checks?.some((c) => !c.ok);
  return (
    <StepBody headingRef={headingRef} title="서버 점검" lead="설치 스크립트가 남긴 도구와 디스크 여유를 확인합니다. 빠진 것이 있으면 무엇을 다시 실행할지 알려 드립니다.">
      {checks && (
        <Part>
          <ul className="flex flex-col divide-y rounded-xl border">
            {checks.map((c, i) => (
              <motion.li key={c.name} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                {c.ok ? <CheckDraw className="text-ok" delay={i * 0.04} /> : <CircleX className="size-4 text-destructive" />}
                <span className="font-medium">{c.name}</span>
                <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{c.detail}</span>
              </motion.li>
            ))}
          </ul>
        </Part>
      )}
      <StepError title="점검을 마치지 못했습니다" error={check.error?.message} />
      {failed && <StepError title="빠진 것이 있습니다" error="서버의 관리자 계정에서 sudo bash setup/install.sh base 를 다시 실행한 뒤 다시 점검하세요." />}
      <Part>
        {done ? (
          <DoneNote onRedo={() => reopen("server")}>서버 준비가 끝났습니다.</DoneNote>
        ) : (
          <div>
            <StatusButton state={check.isPending ? "working" : "idle"} idle={checks ? "다시 점검" : "점검하기"} working="점검 중" onClick={() => check.mutate(undefined, { onSuccess: (r) => r.checks.every((c) => c.ok) && onDone() })} />
          </div>
        )}
      </Part>
    </StepBody>
  );
}
