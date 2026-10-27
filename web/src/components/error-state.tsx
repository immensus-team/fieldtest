import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ErrorState({
  title = "불러오지 못했습니다",
  error,
  onRetry,
  retrying,
  className,
}: {
  title?: string;
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      <TriangleAlert className="size-6 text-amber-500" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        <RotateCw className={cn(retrying && "animate-spin")} />
        다시 시도
      </Button>
    </div>
  );
}

export function Empty({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("py-10 text-center text-sm text-muted-foreground", className)}>{children}</p>;
}
