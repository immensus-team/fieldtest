import { useStartServices } from "@/api/setup";
import { Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

export function StartStep({ setup, headingRef, onDone }: StepProps) {
  const start = useStartServices();
  const services = setup.steps.slack.info.skipped ? "에이전트 루프와 watch를" : "에이전트 루프, watch, Slack을";
  return (
    <StepBody headingRef={headingRef} title="시작" lead={`${services} 켭니다. 켜지면 대시보드로 넘어가고 첫 탐색이 시작됩니다.`}>
      <StepError title="서비스를 켜지 못했습니다" error={start.error?.message} />
      <Part>
        <div>
          <StatusButton state={start.isPending ? "working" : start.isSuccess ? "done" : "idle"} idle="서비스 시작" working="켜는 중" done="시작됨" onClick={() => start.mutate(undefined, { onSuccess: onDone })} />
        </div>
      </Part>
    </StepBody>
  );
}
