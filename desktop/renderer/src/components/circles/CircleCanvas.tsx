import { Plus } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type Circle } from "../../stores/circles-store";

// PLAN-36 Phase C1: the group canvas — a board of typed cards folded from the
// circle event log (canvas.* events). C1 ships the simplest card (a shared
// note) to prove the whole pipe end-to-end; the Decision Card + the draft→
// approve→publish consent flow are C2. Card text is peer content, rendered as
// escaped text (never HTML), and was injection-scanned on receipt.

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  return circle.members.find((m) => m.memberPubkey === pubkey)?.displayName ?? "friend";
}

function fmtWhen(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CircleCanvas({
  circle,
  selfPubkey,
}: {
  circle: Circle;
  selfPubkey: string | undefined;
}) {
  const cards = useCirclesStore((s) => s.cardsByCircle[circle.circleId]);
  const putCard = useCirclesStore((s) => s.putCard);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if ((!title.trim() && !text.trim()) || saving) return;
    setSaving(true);
    const ok = await putCard(circle.circleId, title, text);
    setSaving(false);
    if (ok) {
      setTitle("");
      setText("");
      setAdding(false);
    }
  };

  const list = cards ?? [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Shared canvas
        </span>
        {!adding && circle.status === "active" && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs font-medium text-primary flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> New card
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {adding && (
          <div className="rounded-lg border bg-card p-2.5 space-y-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Card title"
              autoFocus
              className="w-full bg-transparent text-sm font-semibold outline-none"
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Anything the whole circle should see…"
              rows={3}
              className="w-full resize-none bg-transparent text-sm outline-none"
            />
            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setTitle("");
                  setText("");
                }}
                className="text-xs text-muted-foreground px-2 py-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={(!title.trim() && !text.trim()) || saving}
                className="text-xs font-medium px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
              >
                Add to canvas
              </button>
            </div>
          </div>
        )}

        {list.length === 0 && !adding && (
          <div className="text-center text-sm text-muted-foreground px-4 py-10">
            Nothing on the canvas yet. This is the circle&apos;s shared board — notes and, soon,
            your agents&apos; outputs land here for everyone to see.
          </div>
        )}

        {list.map((card) => (
          <div key={card.cardId} className="rounded-lg border bg-card p-3">
            {card.title && <div className="text-sm font-semibold mb-1">{card.title}</div>}
            {card.text && (
              <div className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                {card.text}
              </div>
            )}
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="font-medium">{nameFor(circle, card.authorPubkey, selfPubkey)}</span>
              <span>·</span>
              <span>{fmtWhen(card.updatedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
