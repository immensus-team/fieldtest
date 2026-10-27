import { ImageOff } from "lucide-react";
import { useState } from "react";
import type { ShotRow } from "@/api/types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/error-state";

type Zoom = { src: string; title: string };

function Shot({ src, title, onZoom }: { src: string | null; title: string; onZoom: (zoom: Zoom) => void }) {
  if (!src) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center gap-1.5 rounded-lg border border-dashed text-xs text-muted-foreground">
        <ImageOff className="size-3.5" />
        없음
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onZoom({ src, title })}
      className="group block w-full overflow-hidden rounded-lg border bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${title} 크게 보기`}
    >
      <img
        src={src}
        alt={title}
        loading="lazy"
        className="max-h-80 w-full object-contain object-top transition-transform duration-300 group-hover:scale-[1.02]"
      />
    </button>
  );
}

export function ShotRows({ rows }: { rows: ShotRow[] }) {
  const [zoom, setZoom] = useState<Zoom | null>(null);
  if (rows.length === 0) return <Empty>스크린샷이 없습니다</Empty>;
  return (
    <>
      <div className="space-y-5">
        {rows.map((row) => (
          <figure key={row.label} className="space-y-2">
            <figcaption className="text-xs font-medium text-muted-foreground">{row.label}</figcaption>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">수정 전</p>
                <Shot src={row.before} title={`${row.label} · 수정 전`} onZoom={setZoom} />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">수정 후</p>
                <Shot src={row.after} title={`${row.label} · 수정 후`} onZoom={setZoom} />
              </div>
            </div>
          </figure>
        ))}
      </div>
      <Dialog open={!!zoom} onOpenChange={(open) => !open && setZoom(null)}>
        <DialogContent className="max-h-[92dvh] w-auto max-w-[min(96vw,1400px)] gap-2 overflow-auto p-3 sm:max-w-[min(96vw,1400px)]">
          <DialogTitle className="pr-8 text-sm">{zoom?.title}</DialogTitle>
          {zoom && <img src={zoom.src} alt={zoom.title} className="mx-auto h-auto max-w-full rounded-md" />}
        </DialogContent>
      </Dialog>
    </>
  );
}
