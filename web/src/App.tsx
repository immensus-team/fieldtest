import { AnimatePresence, motion } from "motion/react";
import { useOverview } from "@/api/client";
import { useSetupState } from "@/api/setup";
import { SetupApp } from "@/setup/setup-app";
import { AlertBanner } from "@/components/alert-banner";
import { Board } from "@/components/board/board";
import { TicketSheet } from "@/components/detail/ticket-sheet";
import { ErrorState } from "@/components/error-state";
import { ServerView } from "@/components/server/server-view";
import { TopBar, VIEWS, type View } from "@/components/top-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { LOG_SUBS, LogTab, type LogSub } from "@/components/views/log-tab";
import { useUrlParam } from "@/lib/url-state";

const COLUMN_COUNT = 5;

function BoardSkeleton() {
  return (
    <div className="flex flex-1 gap-3 overflow-hidden px-4 pt-14 pb-4 sm:px-5">
      {Array.from({ length: COLUMN_COUNT }, (_, i) => (
        <Skeleton key={i} className="h-full w-[85vw] max-w-[340px] shrink-0 rounded-2xl sm:w-auto sm:max-w-none sm:min-w-[272px] sm:flex-1" />
      ))}
    </div>
  );
}

// Links from before the 수정/추가/로그 split (?v=board, ?v=commands, …) still open the same screen.
function viewOf(v: string | null, l: string | null): { view: View; sub: LogSub } {
  const subOf = (x: string | null) => (LOG_SUBS.some((s) => s.key === x) ? (x as LogSub) : null);
  const old = subOf(v);
  if (old) return { view: "log", sub: subOf(l) ?? old };
  const view = VIEWS.some((x) => x.key === v) ? (v as View) : "fix";
  return { view, sub: subOf(l) ?? "commands" };
}

// The setup wizard until the install is done, then the dashboard: the wizard's card shrinks and fades
// as the dashboard comes in.
export default function App() {
  const setup = useSetupState();
  const wizard = setup.data?.current != null;
  if (!setup.data) return <div className="h-dvh bg-board" />;
  return (
    <AnimatePresence mode="wait" initial={false}>
      {wizard ? (
        <motion.div key="setup" exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.3 } }}>
          <SetupApp setup={setup.data} />
        </motion.div>
      ) : (
        <motion.div key="dashboard" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.3 } }}>
          <Dashboard />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Dashboard() {
  const overview = useOverview();
  const [v, setView] = useUrlParam("v");
  const [l, setSub] = useUrlParam("l");
  const { view, sub } = viewOf(v, l);
  const board = view === "fix" || view === "add";

  return (
    <div className="flex h-dvh flex-col bg-background">
      <TopBar
        overview={overview.data}
        offline={overview.isError && !!overview.data}
        onRetry={() => overview.refetch()}
        view={view}
        onView={(next) => {
          setView(next === "fix" ? null : next);
          if (next !== "log") setSub(null);
        }}
      />
      {overview.data && <AlertBanner alerts={overview.data.alerts} />}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } }}
          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {board &&
            (overview.data ? (
              <Board overview={overview.data} track={view === "add" ? "improve" : "fix"} />
            ) : overview.isError ? (
              <div className="p-4 sm:p-5">
                <ErrorState
                  title="QA 서버에 연결하지 못했습니다"
                  error={overview.error}
                  onRetry={() => overview.refetch()}
                  retrying={overview.isFetching}
                />
              </div>
            ) : (
              <BoardSkeleton />
            ))}

          {!board && (
            <main className="thin-scroll min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
              <div className={view === "log" && sub === "logs" ? "flex h-full flex-col p-4 sm:p-5" : "mx-auto max-w-6xl p-4 sm:p-5"}>
                {view === "log" && <LogTab sub={sub} onSub={(next) => setSub(next === "commands" ? null : next)} />}
                {view === "server" && <ServerView />}
              </div>
            </main>
          )}
        </motion.div>
      </AnimatePresence>

      <TicketSheet />
    </div>
  );
}
