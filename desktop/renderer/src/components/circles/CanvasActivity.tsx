import { Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { memberName, useCirclesStore, type Circle } from "../../stores/circles-store";

// §3.2.8: chat is the venue, cards are the record. Everything conversational
// about the canvas — your agent's proposals, narration one-liners, pauses,
// agreement prompts, removals — renders HERE, in the chat pane, as items
// DERIVED per-viewer from the fold and the node-local draft/tombstone state.
// Nothing in this file is a wire event and nothing here is synced: peers never
// see your proposal tray; it was always personal to you. (Same
// derived-not-evented discipline as §3.1's lapses; same local-interleave
// mechanism as agent-tool messages.)
//
// Every item carries a card chip that focuses the card on the canvas — chat
// coordinates, the card holds the record.
//
// Deferred with a named reason: the member-join recap (Buzz's best onboarding
// pattern) needs a joinedAt surface on circle members that the fold does not
// expose yet — pending-lane, not silently dropped.

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  const found = circle.members.find((m) => m.memberPubkey === pubkey);
  return found ? memberName(found) : "friend";
}

function atTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** How long a removal stays undoable in the strip before it is just history. */
const REMOVAL_STRIP_WINDOW_MS = 24 * 60 * 60 * 1000;

function CardChip({ title, cardId }: { title: string; cardId: string }) {
  const setFocusCard = useCirclesStore((s) => s.setFocusCard);
  return (
    <button
      type="button"
      onClick={() => setFocusCard(cardId)}
      title="Show this card on the canvas"
      className="inline-flex max-w-40 items-center rounded border bg-muted/60 px-1.5 py-px text-badge font-medium text-foreground align-baseline truncate hover:bg-muted"
    >
      {title || "card"}
    </button>
  );
}

/**
 * The live strip: the canvas's conversational surface inside the chat pane.
 * Renders nothing when nothing needs a human — quiet by default.
 */
export function CanvasLiveStrip({
  circle,
  selfPubkey,
}: {
  circle: Circle;
  selfPubkey: string | undefined;
}) {
  const store = useCirclesStore();
  const sandbox = useCirclesStore((s) => s.sandboxByCircle[circle.circleId]);
  const drafts = useCirclesStore((s) => s.draftsByCircle[circle.circleId]);
  const cards = useCirclesStore((s) => s.cardsByCircle[circle.circleId]);
  const removed = useCirclesStore((s) => s.removedByCircle[circle.circleId]);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const who = (pk: string) => nameFor(circle, pk, selfPubkey);
  const titleOf = (cardId: string) =>
    (cards ?? []).find((c) => c.cardId === cardId)?.title ?? "card";
  const part = sandbox?.participation ?? null;
  const paused = Boolean(part?.pausedAt);
  const budgetPaused = paused && /budget/.test(part?.pauseReason ?? "");
  const sessions = sandbox?.sessions ?? [];

  const proposals = (drafts ?? []).filter((d) => d.kind === "sandbox" && d.targetCardId);
  const thinkingIds = (sandbox?.thinkingCardIds ?? []).filter(
    (id) => !proposals.some((p) => p.targetCardId === id),
  );
  const agreements = sessions.filter((s) => s.status !== "closed" && s.agreedOptionId);
  const lapses = sessions.filter((s) => s.status !== "closed" && s.lapsed.length > 0);
  const stalls = sessions.filter((s) => s.status !== "closed" && s.noProgressAuthors.length > 0);
  const now = Date.now();
  const recentRemovals = (removed ?? [])
    .filter((r) => now - r.removedAt < REMOVAL_STRIP_WINDOW_MS)
    .slice(0, 3);

  const hasAnything =
    proposals.length > 0 ||
    thinkingIds.length > 0 ||
    agreements.length > 0 ||
    lapses.length > 0 ||
    stalls.length > 0 ||
    recentRemovals.length > 0 ||
    (paused && part?.pauseReason);

  if (!hasAnything) return null;

  return (
    <div className="mx-3 mb-1 space-y-1 text-xs" data-testid="canvas-live-strip">
      {/* Your agent's proposals — the one meaningful gate, now conversational. */}
      {proposals.map((p) => (
        <div
          key={p.draftId}
          className="motion-enter-conversation rounded-lg border border-circle-agent/40 bg-circle-agent-soft/40 px-3 py-2"
        >
          <div className="flex items-center gap-1.5 text-badge font-bold uppercase tracking-wide text-circle-agent">
            <Sparkles className="h-3 w-3" />
            Your agent suggests
            <CardChip title={titleOf(p.targetCardId ?? "")} cardId={p.targetCardId ?? ""} />
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-sm">{p.content}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => store.publishDraft(circle.circleId, p.draftId, p.content))
              }
              className="rounded bg-emerald-600 hover:bg-emerald-700 px-2 py-0.5 text-2xs font-semibold text-white"
            >
              Add it
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => store.discardDraft(circle.circleId, p.draftId))}
              className="rounded border px-2 py-0.5 text-2xs hover:bg-muted"
            >
              <X className="mr-0.5 inline h-3 w-3" />
              No
            </button>
            <span className="ml-auto text-badge text-muted-foreground">
              nothing posts without you
            </span>
          </div>
        </div>
      ))}

      {/* Agreement: say so, and let a human be the one to finish it. */}
      {agreements.map((s) => (
        <div
          key={`agree-${s.cardId}`}
          className="motion-enter-conversation flex items-center gap-2 rounded-lg border border-emerald-600/40 bg-emerald-500/10 px-3 py-1.5"
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span className="min-w-0">
            <b className="text-emerald-700 dark:text-emerald-400">Everyone agrees</b> on{" "}
            {s.options.find((o) => o.optionId === s.agreedOptionId)?.label ?? s.agreedOptionId}{" "}
            <CardChip title={titleOf(s.cardId)} cardId={s.cardId} />
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => store.closeSandbox(circle.circleId, s.cardId, "done"))}
            className="ml-auto shrink-0 rounded bg-emerald-600 hover:bg-emerald-700 px-2 py-0.5 text-2xs font-semibold text-white"
          >
            Lock it in
          </button>
        </div>
      ))}

      {/* §3.1: a stop is never quiet — the reason is the detector's, verbatim. */}
      {paused && part?.pauseReason && (
        <div className="motion-enter-conversation flex items-center gap-2 rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-1.5">
          <span className="min-w-0">
            <b className="text-amber-700 dark:text-amber-400">Your agent paused.</b>{" "}
            {part.pauseReason}
          </span>
          {budgetPaused ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => store.setCanvasParticipation(circle.circleId, "propose"))
              }
              className="ml-auto shrink-0 rounded bg-amber-600 hover:bg-amber-700 px-2 py-0.5 text-2xs font-semibold text-white"
            >
              Give it more turns
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => store.resumeSandbox(circle.circleId))}
              className="ml-auto shrink-0 rounded border border-amber-600 px-2 py-0.5 text-2xs font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
            >
              Resume
            </button>
          )}
        </div>
      )}

      {/* Narration one-liners: thinking, lapses, loops, removals. */}
      {thinkingIds.map((id) => (
        <div
          key={`think-${id}`}
          className="flex items-center gap-1.5 px-1 text-2xs text-circle-agent"
        >
          <Sparkles className="h-3 w-3 animate-pulse" />
          Your agent is thinking on <CardChip title={titleOf(id)} cardId={id} />…
        </div>
      ))}
      {lapses.map((s) => (
        <div key={`lapse-${s.cardId}`} className="px-1 text-2xs italic text-muted-foreground">
          {s.lapsed.map(who).join(", ")} passed on{" "}
          <CardChip title={titleOf(s.cardId)} cardId={s.cardId} /> (no answer in time
          {s.passesAt !== null && `; next pass at ${atTime(s.passesAt)}`})
        </div>
      ))}
      {stalls.map((s) => (
        <div key={`stall-${s.cardId}`} className="px-1 text-2xs text-amber-600 dark:text-amber-400">
          {s.noProgressAuthors.map(who).join(", ")} repeated{" "}
          {s.noProgressAuthors.length === 1 ? "itself" : "themselves"} on{" "}
          <CardChip title={titleOf(s.cardId)} cardId={s.cardId} /> — nothing new is being added
        </div>
      ))}
      {recentRemovals.map((r) => (
        <div
          key={`rm-${r.cardId}`}
          className="flex items-center gap-2 px-1 text-2xs text-muted-foreground"
        >
          <span className="min-w-0 truncate">
            {who(r.removedBy)} removed “{r.title || "a card"}” · {atTime(r.removedAt)}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => store.undoRemoveCard(circle.circleId, r))}
            className="shrink-0 font-medium underline-offset-2 hover:underline"
          >
            Undo
          </button>
        </div>
      ))}
    </div>
  );
}
