import { ArrowLeft, ArrowRight, ListOrdered, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { STEP_IDS, type SetupState, type StepId, useReopen } from "@/api/setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTheme } from "@/lib/theme";
import { StepFrame } from "./step-frame";
import { STEP_LABELS, StepProgress, Stepper } from "./stepper";
import { BootstrapStep } from "./steps/bootstrap";
import { LoginStep } from "./steps/logins";
import { RecipeStep } from "./steps/recipe";
import { RepoStep } from "./steps/repo";
import { ServerStep } from "./steps/server";
import { SlackStep } from "./steps/slack";
import { StartStep } from "./steps/start";
import type { StepProps } from "./steps/types";

// After a step finishes, its check draws before the next step slides in.
const ADVANCE_MS = 600;

function StepView({ id, ...props }: StepProps & { id: StepId }) {
  switch (id) {
    case "server":
      return <ServerStep {...props} />;
    case "github":
    case "claude":
    case "codex":
      return <LoginStep kind={id} {...props} />;
    case "repo":
      return <RepoStep {...props} />;
    case "slack":
      return <SlackStep {...props} />;
    case "bootstrap":
      return <BootstrapStep {...props} />;
    case "recipe":
      return <RecipeStep {...props} />;
    case "start":
      return <StartStep {...props} />;
  }
}

export function SetupApp({ setup }: { setup: SetupState }) {
  const { theme, toggle } = useTheme();
  const reopenStep = useReopen();
  const [[viewing, direction], setView] = useState<[StepId, number]>([setup.current ?? "start", 1]);
  const [menu, setMenu] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const index = STEP_IDS.indexOf(viewing);
  const reachable = (id: StepId) => setup.steps[id].done || id === setup.current;

  const go = useCallback((next: StepId) => {
    setView(([now]) => [next, STEP_IDS.indexOf(next) >= STEP_IDS.indexOf(now) ? 1 : -1]);
    setMenu(false);
  }, []);

  // A step on screen that finished moves the wizard on once, after its check has drawn. Two signals lead
  // here (the step's own screen and the server's state), so each visit to a step advances at most once.
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const advanced = useRef<StepId | null>(null);
  const onDone = useCallback(() => {
    const from = viewingRef.current;
    if (advanced.current === from) return;
    advanced.current = from;
    setTimeout(() => {
      setView(([at, dir]) => {
        const next = STEP_IDS[STEP_IDS.indexOf(at) + 1];
        return at === from && next ? [next, 1] : [at, dir];
      });
    }, ADVANCE_MS);
  }, []);

  // The server's state is the source of truth: when the step on screen turns done there, move on even if
  // its screen missed the moment (a reload, a login that finished between polls).
  const viewingDone = setup.steps[viewing].done;
  const seen = useRef({ step: viewing, done: viewingDone });
  useEffect(() => {
    if (seen.current.step !== viewing) {
      // A new visit: what was already done is not a new finish.
      seen.current = { step: viewing, done: viewingDone };
      advanced.current = null;
      return;
    }
    if (viewingDone && !seen.current.done) onDone();
    seen.current.done = viewingDone;
  }, [viewing, viewingDone, onDone]);

  // The heading of the step on screen gets focus, so a keyboard or screen reader starts there.
  useEffect(() => {
    const t = setTimeout(() => headingRef.current?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, [viewing]);

  const reopen = (id: StepId) => {
    reopenStep.mutate(id);
    go(id);
  };
  const prev = STEP_IDS[index - 1];
  const next = STEP_IDS[index + 1];

  return (
    <div className="flex min-h-dvh flex-col bg-board">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:px-6">
        <span className="text-[15px] font-semibold tracking-tight">fieldtest</span>
        <Badge variant="outline" className="font-mono">
          {setup.name}
        </Badge>
        <span className="ml-1 hidden text-sm text-muted-foreground sm:inline">설치</span>
        <Button type="button" variant="ghost" size="icon" className="ml-auto" onClick={toggle} aria-label={theme === "dark" ? "밝은 테마" : "어두운 테마"}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </header>

      <div className="mx-auto grid w-full max-w-5xl flex-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:py-10">
        <aside className="hidden lg:block">
          <nav aria-label="설치 단계" className="sticky top-24">
            <Stepper setup={setup} viewing={viewing} onPick={go} />
          </nav>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center gap-3 lg:hidden">
            <StepProgress setup={setup} viewing={viewing} />
            <Sheet open={menu} onOpenChange={setMenu}>
              <SheetTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <ListOrdered />
                  단계
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[85vw] max-w-sm">
                <SheetHeader>
                  <SheetTitle>설치 단계</SheetTitle>
                  <SheetDescription>끝낸 단계와 지금 단계로 이동할 수 있습니다.</SheetDescription>
                </SheetHeader>
                <div className="px-3">
                  <Stepper setup={setup} viewing={viewing} onPick={go} />
                </div>
              </SheetContent>
            </Sheet>
          </div>

          <StepFrame stepKey={viewing} direction={direction}>
            <StepView id={viewing} setup={setup} headingRef={headingRef} onDone={onDone} reopen={reopen} />
          </StepFrame>

          <nav aria-label="단계 이동" className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" disabled={!prev} onClick={() => prev && go(prev)}>
              <ArrowLeft />
              {prev ? STEP_LABELS[prev] : "뒤로"}
            </Button>
            <Button type="button" variant="outline" disabled={!next || !setup.steps[viewing].done || !reachable(next)} onClick={() => next && go(next)}>
              {next ? STEP_LABELS[next] : "다음"}
              <ArrowRight />
            </Button>
          </nav>
        </div>
      </div>
    </div>
  );
}
