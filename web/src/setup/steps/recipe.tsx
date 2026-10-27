import { motion } from "motion/react";
import { useState } from "react";
import { useRecipe, useRecipeAction } from "@/api/setup";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DoneNote, Part, StatusButton, StepBody, StepError } from "../pieces";
import type { StepProps } from "./types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{s}</code>;

export function RecipeStep({ setup, headingRef, onDone, reopen }: StepProps) {
  const done = setup.steps.recipe.done;
  const recipe = useRecipe(!done);
  const action = useRecipeAction();
  const [feedback, setFeedback] = useState("");
  const r = recipe.data;

  if (done) {
    return (
      <StepBody headingRef={headingRef} title="레시피 확인" lead="승인한 레시피로 탐색과 검사를 합니다.">
        <Part>
          <DoneNote onRedo={() => reopen("recipe")}>레시피를 승인했습니다.</DoneNote>
        </Part>
      </StepBody>
    );
  }
  return (
    <StepBody headingRef={headingRef} title="레시피 확인" lead="에이전트가 쓴 실행 방법과 화면 목록입니다. 맞으면 시작하고, 고칠 점이 있으면 글로 적어 다시 만들게 합니다.">
      {!r ? (
        <Part>
          <Skeleton className="h-40 rounded-xl" />
        </Part>
      ) : (
        <>
          <Part>
            <dl className="divide-y rounded-xl border px-4">
              <Row label="제품">
                <span className="font-medium">{r.product.name}</span> · {r.product.summary}
              </Row>
              <Row label="앱">
                {r.app.kind} · {code(r.app.root)}
              </Row>
              <Row label="실행">
                <div className="flex flex-col gap-1">
                  {r.install.map((c) => (
                    <span key={c}>{code(c)}</span>
                  ))}
                  {r.services && <span>서비스: {code(r.services.compose)}</span>}
                  {r.seed.map((c) => (
                    <span key={c}>시드: {code(c)}</span>
                  ))}
                  <span>시작: {code(r.start.command)}</span>
                </div>
              </Row>
              <Row label="로그인">{r.login.kind === "none" ? "필요 없음" : `${r.login.kind}${r.login.user ? ` · ${r.login.user}` : ""}`}</Row>
              <Row label="검사">
                <div className="flex flex-wrap gap-1.5">
                  {r.checks.map((c) => (
                    <Badge key={c.name} variant="outline" title={c.command}>
                      {c.name}
                    </Badge>
                  ))}
                </div>
              </Row>
              <Row label="고쳐도 되는 경로">{r.paths.allowed.map(code).reduce((a: React.ReactNode[], b, i) => (i ? [...a, " ", b] : [b]), [])}</Row>
            </dl>
          </Part>
          <Part>
            <h3 className="text-sm font-medium">화면 {r.screens.length}개</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {r.screens.map((s, i) => (
                <motion.figure key={s.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="overflow-hidden rounded-xl border">
                  {s.shot ? <img src={s.shot} alt={`${s.id} 화면`} className="aspect-[16/10] w-full bg-muted object-cover object-top" loading="lazy" /> : <div className="grid aspect-[16/10] place-items-center bg-muted text-xs text-muted-foreground">스크린샷 없음</div>}
                  <figcaption className="flex flex-col gap-0.5 p-3">
                    <span className="text-sm font-medium">
                      {s.id} <span className="font-mono text-xs text-muted-foreground">{s.url}</span>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{s.mission}</span>
                  </figcaption>
                </motion.figure>
              ))}
            </div>
          </Part>
          <Part>
            <h3 className="text-sm font-medium">업무 여정</h3>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              {r.journeys.map((j) => (
                <li key={j}>{j}</li>
              ))}
            </ol>
          </Part>
        </>
      )}
      <StepError title="레시피를 처리하지 못했습니다" error={recipe.error?.message ?? action.error?.message} />
      <Part>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <StatusButton state={action.isPending && action.variables?.action === "start" ? "working" : "idle"} idle="이 레시피로 시작" working="승인 중" disabled={!r} onClick={() => r && action.mutate({ action: "start", hash: r.hash }, { onSuccess: onDone })} />
        </div>
        <div className="flex flex-col gap-2">
          <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="고칠 점 (예: 로그인 없이 볼 수 있는 화면도 넣어 주세요)" aria-label="레시피 수정 요청" />
          <div>
            <StatusButton
              variant="outline"
              state={action.isPending && action.variables?.action === "revise" ? "working" : "idle"}
              idle="수정 요청"
              working="보내는 중"
              disabled={!feedback.trim()}
              onClick={() => action.mutate({ action: "revise", feedback }, { onSuccess: () => reopen("bootstrap") })}
            />
          </div>
        </div>
      </Part>
    </StepBody>
  );
}
