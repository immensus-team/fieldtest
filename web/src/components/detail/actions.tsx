import { CheckCircle2, Clock, Loader2, Send, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useSendCommand } from "@/api/client";
import type { ActionKey, Card, Command } from "@/api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_ORDER, ACTIONS } from "@/lib/labels";
import { msOf, relative, shortDateTime, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";

// A queued command with no result after this long means watch did not pick it up.
const UNHANDLED_MS = 2 * 60 * 1000;

// 진행 on a feature proposal builds its spec; the candidate comes back for approval before any PR.
const PROPOSAL_APPROVE = "이 제안서대로 에이전트가 구현해 후보를 만듭니다. 후보가 나오면 다시 승인을 요청합니다.";

function commandState(command: Command, now: number) {
  if (command.ok === true) return "done" as const;
  if (command.ok === false) return "failed" as const;
  const at = msOf(command.at);
  return at !== null && now - at > UNHANDLED_MS ? ("stuck" as const) : ("queued" as const);
}

export function CommandStatus({ command }: { command: Command }) {
  const now = useNow();
  const state = commandState(command, now);
  return (
    <span
      className={cn(
        "inline-flex items-start gap-1.5 text-xs",
        state === "done" && "text-emerald-700 dark:text-emerald-400",
        state === "failed" && "text-red-700 dark:text-red-400",
        state === "stuck" && "text-amber-700 dark:text-amber-400",
        state === "queued" && "text-muted-foreground",
      )}
    >
      {state === "done" && <CheckCircle2 className="mt-px size-3.5 shrink-0" />}
      {state === "failed" && <XCircle className="mt-px size-3.5 shrink-0" />}
      {state === "stuck" && <Clock className="mt-px size-3.5 shrink-0" />}
      {state === "queued" && <Loader2 className="mt-px size-3.5 shrink-0 animate-spin" />}
      <span className="min-w-0 break-words">
        {state === "done" && `처리됨${command.message ? `: ${command.message}` : ""}`}
        {state === "failed" && `실패: ${command.message || "이유 없음"}`}
        {state === "stuck" && "watch가 처리하지 않음"}
        {state === "queued" && "대기 중"}
      </span>
    </span>
  );
}

// Verbs whose work continues after watch accepts them: the loop rebuilds or fixes, or the merge waits on CI.
const FOLLOWED = new Set(["수정", "머지"]);

function CommandOutcome({ command }: { command: Command }) {
  const outcome = command.outcome;
  if (!outcome) {
    if (command.ok !== true || !FOLLOWED.has(command.verb)) return null;
    return (
      <span className="inline-flex items-start gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="mt-px size-3.5 shrink-0 animate-spin" />
        <span>결과 기다리는 중</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-start gap-1.5 text-xs",
        outcome.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400",
      )}
    >
      {outcome.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
      <span className="line-clamp-3 min-w-0 break-words" title={outcome.text}>
        {shortDateTime(outcome.at)} · {outcome.text}
      </span>
    </span>
  );
}

function TextDialog({
  action,
  initial,
  card,
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  action: ActionKey;
  initial: string;
  card: Card;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (text: string) => void;
  pending: boolean;
}) {
  const def = ACTIONS[action];
  const [text, setText] = useState(initial);
  const empty = text.trim() === "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!empty) onSubmit(text.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <span className="mr-2 font-mono text-muted-foreground">{card.id}</span>
              {def.title}
            </DialogTitle>
            <DialogDescription>{def.description}</DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={def.placeholder}
            className="max-h-[50vh] min-h-32"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty) onSubmit(text.trim());
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" variant={def.variant === "destructive" ? "destructive" : "default"} disabled={empty || pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Send />}
              {def.verb} 보내기
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ActionBar({ card, commands }: { card: Card; commands: Command[] }) {
  const now = useNow();
  const send = useSendCommand(card.id);
  const [dialog, setDialog] = useState<ActionKey | null>(null);
  const actions = ACTION_ORDER.filter((a) => card.actions.includes(a));
  const recent = [...commands].sort((a, b) => (msOf(b.at) ?? 0) - (msOf(a.at) ?? 0)).slice(0, 3);
  // While a command waits for watch, another one would act on a stale state.
  const waiting = recent.some((c) => commandState(c, now) === "queued");

  const submit = (action: ActionKey, arg?: string) => {
    const def = ACTIONS[action];
    send.mutate(
      { verb: def.verb, ...(arg ? { arg } : {}) },
      {
        onSuccess: () => {
          toast.success("접수됨", { description: `${card.id} ${def.label}. watch가 처리하면 결과가 여기에 보입니다.` });
          setDialog(null);
        },
        onError: (error) => {
          toast.error(`${def.label}을(를) 보내지 못했습니다`, { description: error.message });
        },
      },
    );
  };

  if (actions.length === 0 && recent.length === 0) return null;

  const confirm = dialog && ACTIONS[dialog].input === "confirm" ? dialog : null;
  const text = dialog && ACTIONS[dialog].input === "text" ? dialog : null;

  return (
    <div className="space-y-2.5">
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => {
            const def = ACTIONS[action];
            return (
              <Button
                key={action}
                size="sm"
                variant={def.variant}
                disabled={waiting || send.isPending}
                onClick={() => setDialog(action)}
              >
                {def.label}
              </Button>
            );
          })}
        </div>
      )}
      {recent.length > 0 && (
        <ul className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2">
          {recent.map((c) => (
            <li key={`${c.at}:${c.verb}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
              <span className="font-medium">{c.verb}</span>
              {c.arg && <span className="max-w-[24ch] truncate text-muted-foreground">{c.arg}</span>}
              <span className="text-muted-foreground">
                {relative(c.at, now)} · {c.source === "web" ? "웹" : "Slack"}
              </span>
              <span className="basis-full sm:ml-auto sm:basis-auto">
                <CommandStatus command={c} />
              </span>
              <span className="basis-full">
                <CommandOutcome command={c} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setDialog(null)}>
        {confirm && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <span className="mr-2 font-mono text-muted-foreground">{card.id}</span>
                {ACTIONS[confirm].title}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm === "approve" && card.status === "proposal" ? PROPOSAL_APPROVE : ACTIONS[confirm].description}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>취소</AlertDialogCancel>
              <AlertDialogAction
                disabled={send.isPending}
                onClick={(e) => {
                  // Keep the dialog open until the server answers.
                  e.preventDefault();
                  submit(confirm);
                }}
              >
                {send.isPending && <Loader2 className="animate-spin" />}
                {ACTIONS[confirm].label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      {text && (
        <TextDialog
          key={text}
          action={text}
          card={card}
          initial={text === "adopt" ? (card.reviseAdvice ?? "") : ""}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onSubmit={(value) => submit(text, value)}
          pending={send.isPending}
        />
      )}
    </div>
  );
}
