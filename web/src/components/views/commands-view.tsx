import { useCommands } from "@/api/client";
import { CommandStatus } from "@/components/detail/actions";
import { Empty, ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { relative, shortDateTime, useNow } from "@/lib/time";
import { useOpenTicket } from "@/lib/url-state";

export function CommandsView() {
  const query = useCommands(100);
  const now = useNow();
  const [, open] = useOpenTicket();

  if (query.isPending) return <Skeleton className="h-80 w-full" />;
  if (query.isError && !query.data)
    return <ErrorState title="명령 기록을 읽지 못했습니다" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} />;
  if (query.data.length === 0) return <Empty>아직 보낸 명령이 없습니다</Empty>;

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-28">시각</TableHead>
            <TableHead className="w-24">티켓</TableHead>
            <TableHead className="w-16">명령</TableHead>
            <TableHead>내용</TableHead>
            <TableHead className="w-16">출처</TableHead>
            <TableHead className="min-w-48">결과</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.data.map((c, i) => (
            <TableRow key={`${c.at}:${c.id}:${i}`}>
              <TableCell className="text-muted-foreground tabular-nums" title={shortDateTime(c.at)}>
                {relative(c.at, now)}
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  onClick={() => open(c.id)}
                  className="font-mono text-xs font-medium underline-offset-4 hover:underline"
                >
                  {c.id}
                </button>
              </TableCell>
              <TableCell className="font-medium">{c.verb}</TableCell>
              <TableCell className="max-w-[28rem] text-muted-foreground">
                <span className="line-clamp-2 whitespace-normal">{c.arg || "-"}</span>
              </TableCell>
              <TableCell className="text-muted-foreground">{c.source === "web" ? "웹" : "Slack"}</TableCell>
              <TableCell className="whitespace-normal">
                <CommandStatus command={c} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
