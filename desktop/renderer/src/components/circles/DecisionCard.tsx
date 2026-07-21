import { Check, Sparkles } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import {
  memberName,
  useCirclesStore,
  type Circle,
  type CanvasCard,
} from "../../stores/circles-store";
import { AgentSliceSuggestion } from "./AgentSliceSuggestion";

// PLAN-36 C2: the Decision Card — a constraint-aware group poll. The options are
// set by the creator (card.text, one per line); each member's VOTE is a separate
// signed slice event (slot "vote"), so contributions merge rather than overwrite.
// Voting is the publish/consent act — in Phase B the member's agent pre-fills the
// selection from private context; the human still clicks to publish it.

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  const found = circle.members.find((m) => m.memberPubkey === pubkey);
  return found ? memberName(found) : "friend";
}

export function DecisionCard({
  card,
  circle,
  selfPubkey,
}: {
  card: CanvasCard;
  circle: Circle;
  selfPubkey: string | undefined;
}) {
  const vote = useCirclesStore((s) => s.vote);
  const requestSliceDraft = useCirclesStore((s) => s.requestSliceDraft);
  const drafts = useCirclesStore((s) => s.draftsByCircle[circle.circleId]);
  const options = card.text
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);
  const votes = card.slices.filter((s) => s.slot === "vote");
  const myVote = votes.find((v) => v.authorPubkey === selfPubkey);
  // B2: a ready agent suggestion targeting this card's vote slot.
  const suggestion = (drafts ?? []).find(
    (d) => d.targetCardId === card.cardId && d.targetSlot === "vote",
  );

  const [selected, setSelected] = useState<string>(myVote?.value ?? "");
  const [note, setNote] = useState<string>(myVote?.note ?? "");
  const [publishing, setPublishing] = useState(false);
  const [asked, setAsked] = useState(false);

  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v.value, (tally.get(v.value) ?? 0) + 1);
  const max = Math.max(0, ...tally.values());
  const leaders = options.filter((o) => (tally.get(o) ?? 0) === max && max > 0);
  const votersFor = (opt: string) =>
    votes.filter((v) => v.value === opt).map((v) => nameFor(circle, v.authorPubkey, selfPubkey));

  const changed = selected !== "" && (selected !== myVote?.value || note !== (myVote?.note ?? ""));

  const publish = async () => {
    if (!selected || publishing) return;
    setPublishing(true);
    await vote(circle.circleId, card.cardId, selected, note);
    setPublishing(false);
  };

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="p-3 pb-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
          Decision · {votes.length} of {circle.members.length} voted
        </div>
        <div className="text-sm font-semibold">{card.title}</div>
        {max > 0 && (
          <div className="mt-1 text-xs text-muted-foreground">
            {leaders.length === 1 ? (
              <>
                Leading: <span className="font-medium text-foreground">{leaders[0]}</span> ({max})
              </>
            ) : (
              <>Tied: {leaders.join(", ")}</>
            )}
          </div>
        )}
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        {options.map((opt) => {
          const count = tally.get(opt) ?? 0;
          const pct = votes.length > 0 ? Math.round((count / votes.length) * 100) : 0;
          const isSel = selected === opt;
          const isMine = myVote?.value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => setSelected(opt)}
              className={cn(
                "w-full text-left rounded-md border px-2.5 py-1.5 relative overflow-hidden transition-colors",
                isSel ? "border-circle-you" : "border-border hover:border-muted-foreground/40",
              )}
            >
              <div
                className="absolute inset-y-0 left-0 bg-circle-you-soft/70"
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
              <div className="relative flex items-center gap-2">
                <span
                  className={cn(
                    "w-3.5 h-3.5 rounded-full border shrink-0 grid place-items-center",
                    isSel ? "border-circle-you bg-circle-you" : "border-muted-foreground/50",
                  )}
                >
                  {isSel && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                </span>
                <span className="text-sm flex-1 min-w-0 truncate">{opt}</span>
                {isMine && <Check className="w-3.5 h-3.5 text-circle-you shrink-0" />}
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">{count}</span>
              </div>
              {count > 0 && (
                <div className="relative text-[11px] text-muted-foreground mt-0.5 pl-5 truncate">
                  {votersFor(opt).join(", ")}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {circle.status === "active" && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          {suggestion && (
            <AgentSliceSuggestion
              draft={suggestion}
              circleId={circle.circleId}
              editable={false}
              canPublish={options.includes(suggestion.content)}
              hint={
                options.includes(suggestion.content)
                  ? undefined
                  : "not one of the options — vote manually"
              }
            />
          )}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why? (optional — shared with the circle)"
            className="w-full bg-transparent text-xs outline-none"
          />
          <div className="flex items-center gap-2">
            {!suggestion && (
              <button
                type="button"
                onClick={() => {
                  setAsked(true);
                  void requestSliceDraft(circle.circleId, card.cardId, "vote");
                }}
                disabled={asked}
                title="Your agent drafts a suggestion only you see; you publish it"
                className="text-xs font-medium px-2 py-1.5 rounded border border-circle-agent/40 text-circle-agent flex items-center gap-1 disabled:opacity-50 shrink-0"
              >
                <Sparkles className="w-3 h-3" /> {asked ? "Drafting…" : "Ask my agent"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void publish()}
              disabled={!changed || publishing}
              className="flex-1 text-xs font-medium py-1.5 rounded bg-circle-you text-white disabled:opacity-50"
            >
              {myVote ? "Update my vote" : "Publish my vote"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
