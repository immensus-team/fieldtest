import { useEffect, useState } from "react";
import { useLogin, useSendLoginCode, useStartLogin } from "@/api/setup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PulseDot, Shake } from "../motion-bits";
import { DeviceCode, DoneNote, Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

type Kind = "github" | "codex" | "claude";

type Copy = {
  title: string;
  lead: string;
  start: string;
  waiting: string;
  done: (info: Record<string, unknown>) => string;
  // The browser sign-ins (Claude, Codex): what the page says after approving, and what to paste back.
  approve?: string;
  paste?: string;
  placeholder?: string;
};

const COPY: Record<Kind, Copy> = {
  github: {
    title: "GitHub 로그인",
    lead: "PR을 열고 merge할 GitHub 계정으로 로그인합니다. PR과 merge는 이 계정 이름으로 남습니다.",
    start: "GitHub 로그인 시작",
    waiting: "승인 페이지에서 코드를 넣고 승인하면 자동으로 넘어갑니다.",
    done: (info) => `${String(info.login ?? "")} 계정으로 로그인했습니다.`,
  },
  codex: {
    title: "Codex 연결",
    lead: "에이전트가 쓰는 Codex에 ChatGPT 계정으로 로그인합니다. 코드 리뷰와 PR 리뷰에 씁니다.",
    start: "Codex 로그인 시작",
    waiting: "로그인을 마무리하고 있습니다.",
    done: () => "Codex에 로그인했습니다.",
    approve: "1. 승인 페이지에서 ChatGPT로 로그인하고 승인합니다. 끝나면 브라우저가 \"연결할 수 없음\" 페이지로 넘어갑니다. 정상입니다.",
    paste: "2. 그 페이지 주소창의 주소(http://127.0.0.1:1455/auth/callback?…)를 통째로 복사해 붙여 넣습니다.",
    placeholder: "http://127.0.0.1:1455/auth/callback?code=…",
  },
  claude: {
    title: "Claude 연결",
    lead: "에이전트가 쓰는 Claude 장기 토큰을 만듭니다. 승인한 뒤 화면에 나온 코드를 붙여 넣으면 서버가 토큰을 받아 한 번 호출해 확인합니다.",
    start: "Claude 로그인 시작",
    waiting: "코드를 확인하고 있습니다.",
    done: () => "Claude 토큰을 저장하고 확인했습니다.",
    approve: "1. 승인 페이지에서 로그인하고 승인합니다.",
    paste: "2. 페이지에 나온 코드를 붙여 넣습니다.",
  },
};

export function LoginStep({ kind, setup, headingRef, onDone, reopen }: StepProps & { kind: Kind }) {
  const copy = COPY[kind];
  const start = useStartLogin(kind);
  const [id, setId] = useState<string | null>(null);
  const status = useLogin(id);
  const sendCode = useSendLoginCode(id);
  const [code, setCode] = useState("");
  const [tries, setTries] = useState(0);
  const done = setup.steps[kind].done;
  const st = status.data;

  useEffect(() => {
    if (st?.state === "done") onDone();
    // The content under the heading changed (code shown, input asked, done): start reading there again.
    if (st?.state && st.state !== "starting") headingRef.current?.focus({ preventScroll: true });
  }, [st?.state, onDone, headingRef]);

  if (done && !id) {
    return (
      <StepBody headingRef={headingRef} title={copy.title} lead={copy.lead}>
        <Part>
          <DoneNote onRedo={() => reopen(kind)}>{copy.done(setup.steps[kind].info)}</DoneNote>
        </Part>
      </StepBody>
    );
  }
  return (
    <StepBody headingRef={headingRef} title={copy.title} lead={copy.lead}>
      {st?.state === "waiting" && (
        <Part>
          <DeviceCode url={st.url} code={st.code} waiting={copy.waiting} />
        </Part>
      )}
      {st?.state === "needs-code" && (
        <Part>
          <ol className="flex flex-col gap-4 rounded-xl border bg-muted/40 p-4 text-sm">
            <li className="flex flex-col gap-2">
              <span className="font-medium">{copy.approve}</span>
              <div>
                <Button asChild size="lg">
                  <a href={st.url} target="_blank" rel="noreferrer">
                    승인 페이지 열기
                  </a>
                </Button>
              </div>
            </li>
            <li className="flex flex-col gap-2">
              <Label htmlFor={`${kind}-code`} className="font-medium">
                {copy.paste}
              </Label>
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!code.trim()) return setTries((n) => n + 1);
                  sendCode.mutate(code);
                }}
              >
                <Shake token={tries || null} className="flex-1">
                  <Input id={`${kind}-code`} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder={copy.placeholder} className="h-9 font-mono" />
                </Shake>
                <StatusButton type="submit" state={sendCode.isPending ? "working" : sendCode.isSuccess ? "done" : "idle"} idle="코드 보내기" working="보내는 중" done="보냄" />
              </form>
              {sendCode.isSuccess && (
                <p className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
                  <PulseDot />
                  {copy.waiting}
                </p>
              )}
            </li>
          </ol>
        </Part>
      )}
      {st?.state === "starting" && (
        <Part>
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <PulseDot /> 로그인 화면을 여는 중입니다.
          </p>
        </Part>
      )}
      {st?.state === "done" && (
        <Part>
          <DoneNote>{copy.done({ ...setup.steps[kind].info })}</DoneNote>
        </Part>
      )}
      <StepError
        title="로그인하지 못했습니다"
        error={st?.state === "failed" ? st.error : (status.error?.message ?? start.error?.message ?? sendCode.error?.message)}
      />
      {(!id || st?.state === "failed" || status.isError) && (
        <Part>
          <div>
            <StatusButton
              state={start.isPending ? "working" : "idle"}
              idle={st?.state === "failed" || status.isError ? "다시 시작" : copy.start}
              working="시작하는 중"
              onClick={() =>
                start.mutate(undefined, {
                  onSuccess: (r) => {
                    setCode("");
                    sendCode.reset();
                    setId(r.id);
                  },
                })
              }
            />
          </div>
        </Part>
      )}
    </StepBody>
  );
}
