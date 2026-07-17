import { Check } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { useCirclesStore, type Circle, type CanvasCard } from "../../stores/circles-store";

// PLAN-36 C2: the Decision Card — a constraint-aware group poll. The options are
// set by the creator (card.text, one per line); each member's VOTE is a separate
// signed slice event (slot "vote"), so contributions merge rather than overwrite.
// Voting is the publish/consent act — in Phase B the member's agent pre-fills the
// selection from private context; the human still clicks to publish it.

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  return circle.members.find((m) => m.memberPubkey === pubkey)?.displayName ?? "friend";
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
  const options = card.text
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);
  const votes = card.slices.filter((s) => s.slot === "vote");
  const myVote = votes.find((v) => v.authorPubkey === selfPubkey);

  const [selected, setSelected] = useState<string>(myVote?.value ?? "");
  const [note, setNote] = useState<string>(myVote?.note ?? "");
  const [publishing, setPublishing] = useState(false);

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
        <div className="text-[10px] font-bold uppercase tracking-wide text-primary mb-1">
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
                isSel ? "border-primary" : "border-border hover:border-muted-foreground/40",
              )}
            >
              <div
                className="absolute inset-y-0 left-0 bg-primary/10"
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
              <div className="relative flex items-center gap-2">
                <span
                  className={cn(
                    "w-3.5 h-3.5 rounded-full border shrink-0 grid place-items-center",
                    isSel ? "border-primary bg-primary" : "border-muted-foreground/50",
                  )}
                >
                  {isSel && <span className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />}
                </span>
                <span className="text-sm flex-1 min-w-0 truncate">{opt}</span>
                {isMine && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
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
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why? (optional — shared with the circle)"
            className="w-full bg-transparent text-xs outline-none"
          />
          <button
            type="button"
            onClick={() => void publish()}
            disabled={!changed || publishing}
            className="w-full text-xs font-medium py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
          >
            {myVote ? "Update my vote" : "Publish my vote"}
          </button>
        </div>
      )}
    </div>
  );
}
