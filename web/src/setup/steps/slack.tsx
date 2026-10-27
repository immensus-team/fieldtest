import { ChevronDown, ExternalLink } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useSaveSlack, useSkipSlack, useSlackManifest, useSlackStatus } from "@/api/setup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PulseDot } from "../motion-bits";
import { CopyButton, DoneNote, Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

export function SlackStep({ setup, headingRef, onDone, reopen }: StepProps) {
  const done = setup.steps.slack.done;
  const manifest = useSlackManifest();
  const save = useSaveSlack();
  const skip = useSkipSlack();
  const status = useSlackStatus(!done);
  const [bot, setBot] = useState("");
  const [app, setApp] = useState("");
  const [showManifest, setShowManifest] = useState(false);
  const text = manifest.data ? JSON.stringify(manifest.data.manifest, null, 2) : "";

  useEffect(() => {
    if (status.data?.owner && !done) onDone();
  }, [status.data?.owner, done, onDone]);

  if (done) {
    const skipped = setup.steps.slack.info.skipped;
    return (
      <StepBody headingRef={headingRef} title="Slack 연결" lead={skipped ? "알림은 대시보드에서만 봅니다." : "사람이 결정할 티켓과 오류만 DM으로 받습니다."}>
        <Part>
          <DoneNote onRedo={() => reopen("slack")} redo={skipped ? "Slack 연결" : undefined}>
            {skipped ? "Slack 없이 진행합니다." : "Slack 앱이 연결되었고 확인 DM을 보냈습니다."}
          </DoneNote>
        </Part>
      </StepBody>
    );
  }
  return (
    <StepBody headingRef={headingRef} title="Slack 연결" lead={`내 워크스페이스에 "fieldtest · ${setup.name}" 앱을 만들고, 사람이 결정할 티켓과 오류를 DM으로 받습니다.`}>
      <Part>
        <h3 className="text-sm font-medium">1. manifest로 앱 만들기</h3>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="lg" disabled={!manifest.data}>
            <a href={manifest.data?.url} target="_blank" rel="noreferrer">
              Slack에서 앱 만들기
              <ExternalLink />
            </a>
          </Button>
          <Button type="button" variant="outline" size="lg" onClick={() => setShowManifest((v) => !v)} aria-expanded={showManifest}>
            manifest 보기
            <motion.span animate={{ rotate: showManifest ? 180 : 0 }} className="inline-flex">
              <ChevronDown />
            </motion.span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">링크에서 manifest가 채워지지 않으면 "From a manifest"를 고르고 아래 원문을 붙여 넣습니다. 만든 뒤 워크스페이스에 설치합니다.</p>
        <AnimatePresence initial={false}>
          {showManifest && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="relative rounded-xl border bg-muted/40">
                <div className="absolute top-2 right-2">
                  <CopyButton text={text} label="manifest 복사" />
                </div>
                <pre className="thin-scroll max-h-64 overflow-auto p-4 font-mono text-xs">{text}</pre>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Part>
      <Part>
        <h3 className="text-sm font-medium">2. 토큰 넣기</h3>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ botToken: bot, appToken: app });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-bot">Bot token (OAuth & Permissions)</Label>
            <Input id="slack-bot" value={bot} onChange={(e) => setBot(e.target.value)} placeholder="xoxb-" autoComplete="off" spellCheck={false} className="h-9 font-mono" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slack-app">App token (Basic Information, connections:write)</Label>
            <Input id="slack-app" value={app} onChange={(e) => setApp(e.target.value)} placeholder="xapp-" autoComplete="off" spellCheck={false} className="h-9 font-mono" />
          </div>
          <div className="sm:col-span-2">
            <StatusButton type="submit" state={save.isPending ? "working" : save.isSuccess ? "done" : "idle"} idle="토큰 저장" working="확인 중" done="저장됨" disabled={!bot || !app} />
          </div>
        </form>
      </Part>
      <StepError title="Slack을 연결하지 못했습니다" error={save.error?.message ?? skip.error?.message} />
      {(save.isSuccess || status.data?.tokens) && (
        <Part>
          <h3 className="text-sm font-medium">3. 봇에게 DM 보내기</h3>
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <PulseDot />
            Slack에서 "fieldtest · {setup.name}" 앱에 아무 말이나 보내세요. 처음 보낸 사람이 알림을 받습니다.
          </p>
        </Part>
      )}
      <Part>
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button type="button" variant="ghost" onClick={() => skip.mutate(undefined, { onSuccess: onDone })} disabled={skip.isPending}>
            Slack 없이 계속
          </Button>
          <p className="text-xs text-muted-foreground">결정할 티켓과 오류는 대시보드에서만 봅니다. 나중에 서버 화면에서 연결할 수 있습니다.</p>
        </div>
      </Part>
    </StepBody>
  );
}
