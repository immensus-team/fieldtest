import { ArrowRight, Compass, GitPullRequest, Scale, Wrench } from "lucide-react";
import { motion, stagger, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// What fieldtest is and how to use it, before the first step. Shown until the server check is done; the
// wizard's header opens it again.
const WORK = [
  { icon: Compass, title: "탐색", body: "사용자처럼 앱을 써 보며 이상한 곳을 찾습니다." },
  { icon: Scale, title: "판정", body: "찾은 문제를 다시 재현해 보고, 진짜 결함인지 가립니다." },
  { icon: Wrench, title: "수정", body: "재현 테스트부터 쓰고 고칩니다. 레포 검사와 Codex 검토를 거칩니다." },
  { icon: GitPullRequest, title: "PR과 merge", body: "진행을 누르면 PR이 열립니다. 리뷰가 끝나면 merge합니다." },
];

const STEPS = [
  ["서버 점검", "필요한 도구와 디스크를 확인합니다."],
  ["GitHub·Claude·Codex 로그인", "PR은 이 GitHub 계정으로 올라갑니다."],
  ["검사할 레포 고르기", "push 권한이 있는 레포 하나."],
  ["Slack (선택)", "알림을 DM으로 받습니다. 건너뛰어도 됩니다."],
  ["실행 지침 만들기", "에이전트가 레포를 읽고 앱을 직접 띄워 봅니다. 10~30분쯤 걸려요."],
  ["확인하고 시작", "결과를 보고 시작하면 대시보드로 넘어갑니다."],
] as const;

const AFTER = [
  "승인 대기의 티켓마다 진행, 거절, 수정을 고릅니다.",
  "리뷰가 끝난 PR은 최종 검토에서 머지합니다.",
  "자동 머지를 켜 두면 작은 수정은 알아서 merge됩니다.",
  "새 버전은 자동으로 받습니다.",
];

const NEED = ["GitHub 계정 (레포 push 권한)", "Claude 구독", "ChatGPT 구독 (Codex)", "Slack (선택)"];

const list = { hidden: {}, show: { transition: { delayChildren: stagger(0.05) } } };
const rise = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { type: "spring", visualDuration: 0.4, bounce: 0 } } } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <motion.section variants={rise} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </motion.section>
  );
}

export function Welcome({ onStart }: { onStart: () => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.div variants={list} initial={reduce ? false : "hidden"} animate="show" className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-4 py-8 break-keep sm:px-6 lg:py-14">
      <motion.div variants={rise} className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">앱을 직접 써 보고 고치는 QA 에이전트</h1>
        <p className="max-w-2xl text-base text-pretty text-muted-foreground">
          내 서버에 설치하고 웹·데스크톱 앱 레포 하나를 연결하세요. 무엇을 고칠지는 사람이 정합니다.
        </p>
        <div>
          <Button size="lg" onClick={onStart}>
            설치 시작
            <ArrowRight />
          </Button>
        </div>
      </motion.div>

      <Section title="하는 일">
        <motion.div variants={list} className="grid gap-3 sm:grid-cols-2">
          {WORK.map(({ icon: Icon, title, body }) => (
            <motion.div key={title} variants={rise}>
              <Card className="h-full gap-2 px-4">
                <div className="flex items-center gap-2">
                  <span className="grid size-7 place-items-center rounded-lg bg-muted">
                    <Icon className="size-4" />
                  </span>
                  <span className="font-medium">{title}</span>
                </div>
                <p className="text-sm text-muted-foreground">{body}</p>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </Section>

      <Section title="설치 순서">
        <ol className="flex flex-col gap-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full border text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
                <span className="text-sm font-medium">{title}</span>
                <span className="text-sm text-muted-foreground">{body}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">창을 닫아도 이어서 할 수 있습니다.</p>
      </Section>

      <Section title="설치한 뒤">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground/30">
          {AFTER.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </Section>

      <Section title="준비물">
        <ul className="flex flex-wrap gap-2">
          {NEED.map((t) => (
            <li key={t} className="rounded-full border bg-card px-3 py-1 text-xs">
              {t}
            </li>
          ))}
        </ul>
      </Section>

      <motion.div variants={rise}>
        <Button size="lg" onClick={onStart}>
          설치 시작
          <ArrowRight />
        </Button>
      </motion.div>
    </motion.div>
  );
}
