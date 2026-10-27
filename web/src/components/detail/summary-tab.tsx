import { Info, Sparkles } from "lucide-react";
import type { TicketDetail } from "@/api/types";
import { Empty } from "@/components/error-state";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[5.5rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="text-sm leading-relaxed whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

export function SummaryTab({ detail }: { detail: TicketDetail }) {
  const { summary, notes, card } = detail;
  return (
    <div className="space-y-5">
      {card.reviseAdvice && (
        <section className="rounded-xl border border-glow/30 bg-gradient-to-br from-glow/10 to-glow-2/10 p-4">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="size-4 text-glow" />
            추천 수정 방향
          </h3>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{card.reviseAdvice}</p>
        </section>
      )}

      {notes.length > 0 && (
        <div className="space-y-2">
          {notes.map((note) => (
            <aside
              key={note.label}
              className="flex gap-2.5 rounded-lg border-l-2 border-amber-500 bg-amber-500/8 px-3.5 py-2.5"
            >
              <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">{note.label}</p>
                <p className="mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap">{note.text}</p>
              </div>
            </aside>
          ))}
        </div>
      )}

      {summary ? (
        <dl className="space-y-3.5 rounded-xl border p-4">
          <Field label="요약">{summary.summary}</Field>
          <Field label="기대">{summary.expected}</Field>
          <Field label="실제">{summary.actual}</Field>
          <Field label="원인">{summary.cause}</Field>
          {summary.fix.length > 0 && (
            <Field label="수정">
              <ul className="list-disc space-y-1 pl-4 marker:text-muted-foreground">
                {summary.fix.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </Field>
          )}
        </dl>
      ) : (
        <Empty>요약 카드가 아직 없습니다. 원문 탭에서 티켓 내용을 볼 수 있습니다.</Empty>
      )}
    </div>
  );
}
