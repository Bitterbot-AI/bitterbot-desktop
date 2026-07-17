import { Send } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type Circle } from "../../stores/circles-store";
import { CircleMessageList } from "./CircleMessageList";

// PLAN-36 Phase A: the center chat pane — header, conversation stream, composer.
// Rides circles.messages / circles.send. Reactions, reply-to, and pins are the
// next A-increments; @-summon agents are Phase B.

interface Props {
  circle: Circle;
  selfPubkey: string | undefined;
}

export function CircleChat({ circle, selfPubkey }: Props) {
  const messages = useCirclesStore((s) => s.messagesByCircle[circle.circleId]);
  const send = useCirclesStore((s) => s.send);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const peerCount = circle.members.filter((m) => !m.isSelf).length;

  const submit = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const ok = await send(circle.circleId, draft);
    setSending(false);
    if (ok) setDraft("");
  };

  return (
    <section className="flex-1 flex flex-col min-w-0">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-semibold text-[15px] truncate">{circle.name}</span>
          <span className="text-xs text-muted-foreground">
            {peerCount === 1 ? "1 friend" : `${peerCount} friends`}
            {circle.status !== "active" && ` · ${circle.status}`}
          </span>
        </div>
        <span className="text-[11px] font-medium px-2 py-1 rounded-full border text-muted-foreground whitespace-nowrap">
          Agents: summon-only
        </span>
      </header>

      <CircleMessageList
        messages={messages ?? []}
        members={circle.members}
        selfPubkey={selfPubkey}
      />

      <div className="m-3 rounded-xl border bg-card flex items-end gap-2 p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder={
            circle.status === "active"
              ? "Message the circle…"
              : "This circle is frozen — messages are paused"
          }
          disabled={circle.status !== "active"}
          className="flex-1 resize-none bg-transparent text-sm outline-none px-1 py-1.5 max-h-32 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!draft.trim() || sending || circle.status !== "active"}
          className="w-8 h-8 rounded-lg grid place-items-center bg-primary text-primary-foreground disabled:opacity-40"
          aria-label="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </section>
  );
}
