import { Bot } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type PendingOutbound } from "../../stores/circles-store";

// PLAN-36 §5.3: THE approval card — the only path by which an agent tool write
// (send / ask / log_expense) reaches the circle. The server holds the exact
// params it will execute; this card shows the preview and the human decides.
// No approval → it expires in 60 minutes and nothing ever left the node.

function describe(p: PendingOutbound): string {
  const v = p.preview;
  switch (p.action) {
    case "send":
      return `send: “${String(v.text ?? "")}”`;
    case "ask":
      return `ask your people (${String(v.category ?? "general")}): “${String(v.question ?? "")}”`;
    case "log_expense":
      return `log $${Number(v.amount ?? 0).toFixed(2)} “${String(v.memo ?? "")}” split among ${String(v.splitAmong ?? "?")}`;
    default:
      return p.action;
  }
}

export function PendingOutboundCard({ pending }: { pending: PendingOutbound }) {
  const approveOutbound = useCirclesStore((s) => s.approveOutbound);
  const rejectOutbound = useCirclesStore((s) => s.rejectOutbound);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const mins = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 60_000));

  return (
    <div className="mx-3 mb-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <Bot className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500 shrink-0" />
        <span className="font-medium">Your agent wants to {pending.action.replace("_", " ")}</span>
        <span className="ml-auto text-muted-foreground shrink-0">expires in {mins}m</span>
      </div>
      <div className="text-sm whitespace-pre-wrap break-words">{describe(pending)}</div>
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => void act(() => rejectOutbound(pending.circleId, pending.id))}
          disabled={busy}
          className="text-xs text-muted-foreground px-2 py-1"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => void act(() => approveOutbound(pending.circleId, pending.id))}
          disabled={busy}
          className="text-xs font-medium px-3 py-1 rounded bg-amber-600 text-white disabled:opacity-50"
        >
          Approve &amp; send
        </button>
      </div>
    </div>
  );
}
