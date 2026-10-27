import { Loader2 } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useLogs } from "@/api/client";
import type { LogLine } from "@/api/types";
import { ErrorState } from "@/components/error-state";
import { LogView } from "@/components/log-view";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SOURCES: { key: LogLine["source"]; label: string }[] = [
  { key: "loop", label: "loop" },
  { key: "watch", label: "watch" },
  { key: "slack", label: "Slack" },
];

export function LogsView() {
  const [source, setSource] = useState<LogLine["source"]>("loop");
  const [ticket, setTicket] = useState("");
  const filter = useDeferredValue(/^QA-\d{4}$/.test(ticket.trim()) ? ticket.trim() : "");
  const query = useLogs(source, filter, 300);
  const partial = ticket.trim() !== "" && filter === "";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={source} onValueChange={(v) => setSource(v as LogLine["source"])}>
          <SelectTrigger className="w-28" aria-label="로그 종류">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={ticket}
          onChange={(e) => setTicket(e.target.value.toUpperCase())}
          placeholder="티켓 번호 (QA-0019)"
          className="h-8 w-48 font-mono text-[13px]"
          aria-label="티켓 필터"
        />
        {partial && <span className="text-xs text-muted-foreground">QA-0000 형식으로 입력하면 걸러집니다</span>}
        {query.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      {query.isError && !query.data ? (
        <ErrorState title="로그를 읽지 못했습니다" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />
      ) : (
        <LogView lines={query.data ?? []} className="min-h-80 flex-1" />
      )}
    </div>
  );
}
