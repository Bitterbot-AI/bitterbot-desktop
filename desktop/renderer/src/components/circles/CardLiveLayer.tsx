import { Check } from "lucide-react";
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
// §3.2.8 slimmed it to the record: chat = coordination, card = content,
// pill = state. The card shows WHAT is being built (contributions, options,
// the tally, your composer) under one status pill and one byline. Everything
// conversational — proposals, thinking, pauses, agreement prompts, steering —
// lives in the chat pane (CanvasActivity), not here. The words "sandbox",
// "session", "enroll", and "frame" remain internal vocabulary and appear
// nowhere on screen.

const FINISHED_LABELS: Record<string, string> = {
  done: "finished",
  cap: "out of rounds",
  no_progress: "stopped — repeating",
  budget: "out of turns",
  human: "finished",
};

function atTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  const found = circle.members.find((m) => m.memberPubkey === pubkey);
  return found ? memberName(found) : "friend";
}

/** §3.2.10 grammar: state is a pill — one word-ish, scannable, never a banner. */
function StatusPill({
  tone,
  label,
}: {
  tone: "quiet" | "live" | "waiting" | "done";
  label: string;
}) {
  const tones: Record<string, string> = {
    quiet: "border text-muted-foreground",
    live: "border-circle-agent/50 bg-circle-agent-soft/50 text-circle-agent",
    waiting: "border-amber-600/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    done: "border-emerald-600/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-px text-badge font-medium ${tones[tone]}`}
      data-testid="card-status-pill"
    >
      {label}
    </span>
  );
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
  const hasProposal = (drafts ?? []).some((d) => d.kind === "sandbox" && d.targetCardId === cardId);
  const thinking = sandbox?.thinkingCardIds.includes(cardId) ?? false;

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
      const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
      const optionId =
        kind === "option.add"
          ? slug
            ? `opt-${slug}`
            : `opt-${session.moves.length + 1}`
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

  // One pill, one byline. The pill answers "what state is this card in";
  // the byline answers "whose work is this". Everything actionable about
  // those states lives in the chat strip.
  const pill = finished
    ? ({
        tone: "done",
        label: FINISHED_LABELS[session.closed?.reason ?? "human"] ?? "finished",
      } as const)
    : session.agreedOptionId
      ? ({ tone: "done", label: "agreed — lock it in from chat" } as const)
      : hasProposal
        ? ({ tone: "live", label: "pending your OK" } as const)
        : thinking
          ? ({ tone: "live", label: "your agent · thinking…" } as const)
          : paused
            ? ({ tone: "waiting", label: "paused" } as const)
            : session.waitingOn.length > 0 && session.moves.length > 0
              ? ({
                  tone: "waiting",
                  label: `waiting on ${session.waitingOn.map(who).join(", ")}${
                    session.passesAt !== null ? ` · passes ${atTime(session.passesAt)}` : ""
                  }`,
                } as const)
              : session.moves.length > 0
                ? ({ tone: "live", label: `${session.moves.length} contributions` } as const)
                : ({ tone: "quiet", label: "ready" } as const);

  const byline =
    session.speakers.length > 0
      ? `${session.speakers.map(who).join(", ")}${
          session.speakers.length === 1 ? "'s agent" : "'s agents"
        } on this`
      : "no agents on this yet";

  // Finished cards keep the artifact and one attributed line — that is the
  // point of finishing.
  if (finished) {
    return (
      <div className="mt-2 border-t pt-1.5">
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <StatusPill tone="done" label={pill.label} />
          <span>
            {who(session.closed?.byPubkey ?? "")} · {session.moves.length} contributions
          </span>
        </div>
        {session.options.length > 0 && (
          <OptionsTally session={session} selfPubkey={selfPubkey} who={who} readOnly />
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
        <StatusPill tone={pill.tone} label={pill.label} />
        <span>{byline}</span>
        {session.lapsed.length > 0 && (
          <span className="italic">· {session.lapsed.map(who).join(", ")} passed</span>
        )}
      </div>

      {/* contributions, newest last, attributed and agent-labeled (R18) */}
      {session.moves.length > 0 && (
        <div className="space-y-1">
          {session.moves.map((m) => (
            <div key={m.eventHash} className="flex gap-2 text-sm">
              <div
                className={`w-0.5 shrink-0 self-stretch rounded ${
                  m.kind === "option.add" ? "bg-emerald-500" : "bg-circle-agent"
                }`}
              />
              <div className="min-w-0">
                <div className="text-2xs text-muted-foreground">
                  <span className="font-medium text-foreground">{who(m.authorPubkey)}</span>
                  {m.agentAuthored && <span className="text-circle-agent">&apos;s agent</span>}
                </div>
                {m.kind === "option.add" ? (
                  <div className="font-medium text-emerald-600">+ {m.label}</div>
                ) : m.kind === "vote" ? (
                  <div className="text-muted-foreground">
                    voted{" "}
                    {session.options.find((o) => o.optionId === m.optionId)?.label ?? m.optionId}
                  </div>
                ) : m.kind === "pass" ? (
                  <div className="italic text-muted-foreground">passed</div>
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
        <OptionsTally
          session={session}
          selfPubkey={selfPubkey}
          who={who}
          busy={busy}
          onVote={(optionId) =>
            void run(() => store.sandboxMove(circle.circleId, cardId, "vote", { optionId }))
          }
        />
      )}

      {/* your own hands — always available, no agent required */}
      {composer === null ? (
        <div className="flex items-center gap-3 text-2xs">
          <button
            type="button"
            onClick={() => setComposer("constraint")}
            className="font-medium text-circle-you"
          >
            + Add something
          </button>
          <button
            type="button"
            onClick={() => setComposer("option")}
            className="font-medium text-circle-you"
          >
            + Add an option
          </button>
        </div>
      ) : (
        <div className="space-y-1.5 rounded-md border p-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            placeholder={
              composer === "constraint"
                ? "Something the group should know, e.g. “free June 19–26, under $200/night”"
                : "An option to consider, e.g. “Cabin B — $185/night”"
            }
            className="w-full rounded border bg-background/50 px-2 py-1 text-sm outline-none focus:border-circle-you"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void post(composer === "constraint" ? "constraint" : "option.add")}
              className="rounded bg-circle-you px-2 py-0.5 text-2xs font-semibold text-circle-you-fg"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setComposer(null);
                setText("");
              }}
              className="text-2xs text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionsTally({
  session,
  selfPubkey,
  who,
  busy = false,
  onVote,
  readOnly = false,
}: {
  session: SandboxSession;
  selfPubkey: string | undefined;
  who: (pk: string) => string;
  busy?: boolean;
  onVote?: (optionId: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div>
      {session.options.map((o) => {
        const voters = session.votes[o.optionId] ?? [];
        const mine = selfPubkey ? voters.includes(selfPubkey) : false;
        const agreed = session.agreedOptionId === o.optionId;
        return (
          <div key={o.optionId} className="flex items-center gap-2 py-0.5 text-sm">
            <span className={`min-w-0 flex-1 truncate ${agreed ? "font-semibold" : ""}`}>
              {o.label}
            </span>
            <span className="text-2xs text-muted-foreground">
              {voters.length > 0 ? voters.map(who).join(" · ") : ""}
            </span>
            {mine ? (
              <span className="shrink-0 text-2xs font-medium text-emerald-600">
                <Check className="inline h-3 w-3" /> you
              </span>
            ) : (
              !readOnly && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onVote?.(o.optionId)}
                  className="shrink-0 rounded border border-emerald-600 px-2 py-0.5 text-2xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                >
                  Vote
                </button>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
