import { Reply, Send, X } from "lucide-react";
import { useState } from "react";
import { useCirclesStore, type Circle, type CircleMessage } from "../../stores/circles-store";
import { AgentDraftCard } from "./AgentDraftCard";
import { CircleMessageList } from "./CircleMessageList";

// PLAN-36 Phase A: the center chat pane — header, conversation stream, composer.
// A3 adds reply-to (a compact quote banner + the parent's envelope id on send).
// Phase B: @agent in a message summons the reader's OWN agent, whose draft
// appears above the composer as a private consent card (AgentDraftCard).

interface Props {
  circle: Circle;
  selfPubkey: string | undefined;
}

function replyLabel(m: CircleMessage, selfPubkey: string | undefined, members: Circle["members"]) {
  if (m.direction === "out" || m.authorPubkey === selfPubkey) return "You";
  return members.find((x) => x.memberPubkey === m.authorPubkey)?.displayName ?? "friend";
}

export function CircleChat({ circle, selfPubkey }: Props) {
  const messages = useCirclesStore((s) => s.messagesByCircle[circle.circleId]);
  const agentDrafts = useCirclesStore((s) => s.draftsByCircle[circle.circleId]);
  const send = useCirclesStore((s) => s.send);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<CircleMessage | null>(null);

  const peerCount = circle.members.filter((m) => !m.isSelf).length;

  const submit = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const ok = await send(circle.circleId, draft, replyTo?.envelopeId ?? undefined);
    setSending(false);
    if (ok) {
      setDraft("");
      setReplyTo(null);
    }
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
        onReply={setReplyTo}
      />

      {(agentDrafts ?? []).map((d) => (
        <AgentDraftCard key={d.draftId} draft={d} circle={circle} selfPubkey={selfPubkey} />
      ))}

      {replyTo && (
        <div className="mx-3 -mb-1 flex items-center gap-2 text-xs text-muted-foreground border rounded-t-lg bg-muted/50 px-3 py-1.5">
          <Reply className="w-3.5 h-3.5 shrink-0" />
          <span className="shrink-0 font-medium">
            Replying to {replyLabel(replyTo, selfPubkey, circle.members)}
          </span>
          <span className="truncate opacity-80">{replyTo.content}</span>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            aria-label="Cancel reply"
            className="ml-auto shrink-0 hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

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
