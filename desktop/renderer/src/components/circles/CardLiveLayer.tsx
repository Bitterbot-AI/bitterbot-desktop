import { Check, Pause, Play, Sparkles, X } from "lucide-react";
import { useState } from "react";
import {
  memberName,
  useCirclesStore,
  type Circle,
  type SandboxSession,
  type SandboxState,
} from "../../stores/circles-store";

// PLAN-38: the live layer every canvas card carries.
//
// Cards are alive by nature, so this is NOT a card type and NOT a mode — it
// renders under whatever the card already shows (a note's text, a decision's
// options, a guide's sections). When nothing is happening it is a single quiet
// line; when agents and people are working it shows the work.
//
// Deliberately absent, because they were friction rather than features: any
// "start a session" act, per-card enrollment, and a button to summon the
// practice partner. The words "sandbox", "session", "enroll", and "frame" are
// internal vocabulary and appear nowhere on screen.

const FINISHED_LABELS: Record<string, string> = {
  done: "finished",
  cap: "stopped — it ran out of rounds",
  no_progress: "stopped — no new ground was being covered",
  budget: "stopped — the turn budget ran out",
  human: "finished by a member",
};

/** "passes at 4:12" — a wait always names a person AND a time (§3.1). */
function atTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  const found = circle.members.find((m) => m.memberPubkey === pubkey);
  return found ? memberName(found) : "friend";
}

export function CardLiveLayer({
  cardId,
  circle,
  selfPubkey,
  sandbox,
}: {
  cardId: string;
  circle: Circle;
  selfPubkey: string | undefined;
  sandbox: SandboxState | undefined;
}) {
  const store = useCirclesStore();
  const drafts = useCirclesStore((s) => s.draftsByCircle[circle.circleId]);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<"constraint" | "option" | null>(null);
  const [text, setText] = useState("");

  const session: SandboxSession | undefined = sandbox?.sessions.find((s) => s.cardId === cardId);
  if (!session) return null;

  const who = (pk: string) => nameFor(circle, pk, selfPubkey);
  const part = sandbox?.participation ?? null;
  const paused = Boolean(part?.pausedAt);
  const finished = session.status === "closed";
  const proposal = (drafts ?? []).find((d) => d.kind === "sandbox" && d.targetCardId === cardId);
  const hasActivity = session.moves.length > 0 || Boolean(proposal);

  const run = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const post = (kind: "constraint" | "option.add") =>
    run(async () => {
      const value = text.trim();
      if (!value) return false;
      const optionId =
        kind === "option.add"
          ? `opt-${value
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 24)}` || `opt-${session.moves.length + 1}`
          : undefined;
      const ok = await store.sandboxMove(circle.circleId, cardId, kind, {
        text: kind === "constraint" ? value : undefined,
        optionId,
        label: kind === "option.add" ? value : undefined,
      });
      if (ok) {
        setText("");
        setComposer(null);
      }
      return ok;
    });

  // Finished cards collapse to a single attributed line — the artifact above
  // is what remains, which is the point.
  if (finished) {
    return (
      <div className="mt-2 border-t pt-1.5 text-[11px] text-muted-foreground">
        {FINISHED_LABELS[session.closed?.reason ?? "human"] ?? "finished"} ·{" "}
        {who(session.closed?.byPubkey ?? "")} · {session.moves.length} contributions
      </div>
    );
  }

  return (
    <div className="mt-2 border-t pt-2 space-y-2">
      {/* The goal restated next to the latest work: drifting is the owner's
          judgment to make, never a model's, so the comparison is on screen. */}
      {hasActivity && session.goal && (
        <div className="text-[11px] text-muted-foreground italic">Working on: {session.goal}</div>
      )}

      {/* who is working this, and what it waits on */}
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
        {session.speakers.length > 0 ? (
          <span>
            {session.speakers.map(who).join(", ")}
            {session.speakers.length === 1 ? "'s agent is" : "'s agents are"} on this
          </span>
        ) : (
          <span>No agents on this card yet</span>
        )}
        {hasActivity && (
          <span className="tabular-nums">· {session.moves.length} contributions</span>
        )}
        {session.waitingOn.length > 0 && hasActivity && (
          <span className="text-amber-600 font-medium">
            · waiting on {session.waitingOn.map(who).join(", ")}
            {session.passesAt !== null && ` (passes at ${atTime(session.passesAt)})`}
          </span>
        )}
        {session.lapsed.length > 0 && (
          <span className="italic">· {session.lapsed.map(who).join(", ")} passed, no answer</span>
        )}
        {paused && (
          <span className="ml-auto flex items-center gap-1.5 text-emerald-600 font-medium">
            paused — {part?.pauseReason ?? "by you"}
            <button
              type="button"
              onClick={() => void run(() => store.resumeSandbox(circle.circleId))}
              className="underline"
            >
              <Play className="w-3 h-3 inline" /> resume
            </button>
          </span>
        )}
        {!paused && part?.mode === "propose" && (
          <button
            type="button"
            onClick={() => void run(() => store.pauseSandbox(circle.circleId))}
            className="ml-auto text-emerald-700"
            title="Pause your agent everywhere on this canvas"
          >
            <Pause className="w-3 h-3 inline" /> pause
          </button>
        )}
      </div>

      {/* §3.1: a stop is never quiet. The agent paused itself, in words, with
          one tap back — and the reason is the one the detector recorded, not
          a generic "something happened". */}
      {paused && part?.pauseReason && (
        <div className="rounded-md border border-amber-600/40 bg-amber-500/10 px-2 py-1.5 text-xs">
          <b className="text-amber-700">Paused.</b> {part.pauseReason}
        </div>
      )}
      {!paused && session.noProgressAuthors.length > 0 && (
        <div className="text-[11px] text-amber-600">
          {session.noProgressAuthors.map(who).join(", ")} repeated{" "}
          {session.noProgressAuthors.length === 1 ? "itself" : "themselves"} — nothing new is being
          added
        </div>
      )}

      {/* Everyone agrees: say so, and let a human be the one to finish it. */}
      {session.agreedOptionId && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-600/40 bg-emerald-500/10 px-2 py-1.5 text-xs">
          <span>
            <b className="text-emerald-700">Everyone agrees</b> on{" "}
            {session.options.find((o) => o.optionId === session.agreedOptionId)?.label ??
              session.agreedOptionId}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => store.closeSandbox(circle.circleId, cardId, "done"))}
            className="ml-auto rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white"
          >
            Lock it in
          </button>
        </div>
      )}

      {/* your agent's proposal, awaiting your tap — the one meaningful gate */}
      {proposal && (
        <div className="rounded-md border border-circle-agent/50 bg-circle-agent/5 p-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-circle-agent mb-1">
            <Sparkles className="w-3 h-3 inline mr-1" />
            Your agent suggests
          </div>
          <div className="text-sm whitespace-pre-wrap break-words">{proposal.content}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  store.publishDraft(circle.circleId, proposal.draftId, proposal.content),
                )
              }
              className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white"
            >
              Add it
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => store.discardDraft(circle.circleId, proposal.draftId))}
              className="rounded border px-2 py-0.5 text-[11px]"
            >
              <X className="w-3 h-3 inline" /> No
            </button>
          </div>
        </div>
      )}

      {/* contributions, newest last, attributed and agent-labeled (R18) */}
      {session.moves.length > 0 && (
        <div className="space-y-1">
          {session.moves.map((m) => (
            <div key={m.eventHash} className="flex gap-2 text-sm">
              <div
                className={`w-0.5 rounded self-stretch shrink-0 ${
                  m.kind === "option.add" ? "bg-emerald-500" : "bg-circle-agent"
                }`}
              />
              <div className="min-w-0">
                <div className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{who(m.authorPubkey)}</span>
                  {m.agentAuthored && <span className="text-circle-agent">&apos;s agent</span>}
                </div>
                {m.kind === "option.add" ? (
                  <div className="text-emerald-600 font-medium">+ {m.label}</div>
                ) : m.kind === "vote" ? (
                  <div className="text-muted-foreground">
                    voted{" "}
                    {session.options.find((o) => o.optionId === m.optionId)?.label ?? m.optionId}
                  </div>
                ) : m.kind === "pass" ? (
                  <div className="text-muted-foreground italic">passed</div>
                ) : (
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* options with votes — the artifact this card is building */}
      {session.options.length > 0 && (
        <div>
          {session.options.map((o) => {
            const voters = session.votes[o.optionId] ?? [];
            const mine = selfPubkey ? voters.includes(selfPubkey) : false;
            return (
              <div key={o.optionId} className="flex items-center gap-2 py-0.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {voters.length > 0 ? voters.map(who).join(" · ") : ""}
                </span>
                {mine ? (
                  <span className="shrink-0 text-[11px] text-emerald-600 font-medium">
                    <Check className="w-3 h-3 inline" /> you
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        store.sandboxMove(circle.circleId, cardId, "vote", {
                          optionId: o.optionId,
                        }),
                      )
                    }
                    className="shrink-0 rounded border border-emerald-600 px-2 py-0.5 text-[11px] text-emerald-600 font-medium"
                  >
                    Vote
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* your own hands — always available, no agent required */}
      {composer === null ? (
        <div className="flex items-center gap-3 text-[11px]">
          <button
            type="button"
            onClick={() => setComposer("constraint")}
            className="text-circle-you font-medium"
          >
            + Add something
          </button>
          <button
            type="button"
            onClick={() => setComposer("option")}
            className="text-circle-you font-medium"
          >
            + Add an option
          </button>
        </div>
      ) : (
        <div className="rounded-md border p-1.5 space-y-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            placeholder={
              composer === "constraint"
                ? "Something the group should know, e.g. “free June 19–26, under $200/night”"
                : "An option to consider, e.g. “Cabin B — $185/night”"
            }
            className="w-full bg-transparent text-sm outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void post(composer === "constraint" ? "constraint" : "option.add")}
              className="rounded bg-circle-you px-2 py-0.5 text-[11px] font-semibold text-circle-you-fg"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setComposer(null);
                setText("");
              }}
              className="text-[11px] text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
