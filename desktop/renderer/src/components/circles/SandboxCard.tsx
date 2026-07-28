import { Bot, Check, ChevronDown, Pause, Play, Sparkles, X, Zap } from "lucide-react";
import { useState } from "react";
import {
  memberName,
  useCirclesStore,
  type CanvasCard,
  type Circle,
  type SandboxSession,
  type SandboxState,
} from "../../stores/circles-store";

// PLAN-38 P1(b): the sandbox session ON a canvas card — the first on-screen
// slice of "several private memories safely working one shared artifact".
// Layout follows the reviewed mockup and §3's three decisions:
//  1. Artifact above feed (the Decision table first, moves as diffs second).
//  2. Every wait names a person or a time — the wait line is the fold's
//     "waiting on", never a spinner.
//  3. Pause is one tap, no confirm, and every terminal state says why.
// The oversight drawer (verdict band, budgets, consent, guidance) renders
// INSIDE the card: enrollment is per-card, so oversight sits on the thing it
// oversees. All peer strings arrive fold-side re-capped and render as text.

const CLOSE_LABELS: Record<string, string> = {
  done: "ratified and closed",
  cap: "closed: round cap reached",
  no_progress: "closed: no progress across rounds",
  budget: "closed: budget exhausted",
  human: "closed by a member",
};

function nameFor(circle: Circle, pubkey: string, selfPubkey: string | undefined): string {
  if (pubkey === selfPubkey) return "You";
  const found = circle.members.find((m) => m.memberPubkey === pubkey);
  return found ? memberName(found) : "friend";
}

export function SandboxCard({
  card,
  session,
  sandbox,
  circle,
  selfPubkey,
}: {
  card: CanvasCard;
  session: SandboxSession;
  sandbox: SandboxState;
  circle: Circle;
  selfPubkey: string | undefined;
}) {
  const store = useCirclesStore();
  const drafts = useCirclesStore((s) => s.draftsByCircle[circle.circleId]);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<"constraint" | "option" | null>(null);
  const [text, setText] = useState("");
  const [guidance, setGuidance] = useState(session.myEnrollment?.guidance ?? "");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const who = (pk: string) => nameFor(circle, pk, selfPubkey);
  const enr = session.myEnrollment;
  const enrolled = enr?.mode === "propose";
  const paused = Boolean(enr?.pausedAt);
  const closed = session.status === "closed";
  const isPractice = (pk: string) => pk === sandbox.practicePubkey;

  // The propose tray: a ready sandbox draft targeting this card.
  const proposal = (drafts ?? []).find(
    (d) => d.kind === "sandbox" && d.targetCardId === card.cardId,
  );

  // The verdict band's work ratio: deltas = honored moves that changed the
  // artifact (options + votes), deliberately not an activity count (§3.2.3).
  const deltas =
    session.options.length + Object.values(session.votes).reduce((n, v) => n + v.length, 0);

  const run = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const postConstraint = () =>
    run(async () => {
      const ok = await store.sandboxMove(circle.circleId, card.cardId, "constraint", {
        text: text.trim(),
      });
      if (ok) {
        setText("");
        setComposer(null);
      }
      return ok;
    });

  const postOption = () =>
    run(async () => {
      const label = text.trim();
      const optionId = `opt-${label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24)}`;
      const ok = await store.sandboxMove(circle.circleId, card.cardId, "option.add", {
        optionId: optionId || `opt-${Date.now() % 100000}`,
        label,
      });
      if (ok) {
        setText("");
        setComposer(null);
      }
      return ok;
    });

  return (
    <div className="rounded-lg border border-circle-agent/40 bg-card overflow-hidden">
      {/* header: format chip + session chip + status/live pill */}
      <div className="p-3 pb-2">
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold uppercase tracking-wide">
          <span className="text-muted-foreground">{card.cardType}</span>
          <span className="text-circle-agent flex items-center gap-1">
            <Zap className="w-3 h-3" /> agents · {session.taskType}
          </span>
          <span
            className={
              closed
                ? "text-muted-foreground"
                : session.status === "live"
                  ? "text-emerald-500"
                  : "text-muted-foreground"
            }
          >
            {closed
              ? (CLOSE_LABELS[session.closed?.reason ?? "human"] ?? "closed")
              : session.status === "live"
                ? `● live · round ${session.currentRound + 1} of ${session.roundCap}`
                : "gathering"}
          </span>
        </div>
        <div className="text-sm font-semibold mt-1">{card.title || session.goal}</div>
        {session.goal && session.goal !== card.title && (
          <div className="text-xs text-muted-foreground mt-0.5">{session.goal}</div>
        )}
      </div>

      {/* enrolled agents */}
      <div className="px-3 pb-2 flex items-center gap-1.5 flex-wrap">
        {session.enrollments
          .filter((e) => e.mode !== "off")
          .map((e) => (
            <span
              key={e.authorPubkey}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                e.authorPubkey === selfPubkey ? "border-emerald-600/50" : "border-border"
              } ${isPractice(e.authorPubkey) ? "border-dashed" : ""}`}
            >
              <Bot className="w-3 h-3 text-circle-agent" />
              {who(e.authorPubkey)}&apos;s agent
              {isPractice(e.authorPubkey) && (
                <span className="text-muted-foreground">· simulated</span>
              )}
              {e.authorPubkey === selfPubkey && enr && (
                <span className="text-muted-foreground tabular-nums">
                  {enr.turnsUsed}/{enr.turnBudget}
                </span>
              )}
            </span>
          ))}
        {!enrolled && !closed && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                store.enrollSandbox(circle.circleId, card.cardId, "propose", { guidance }),
              )
            }
            className="rounded-full border border-dashed border-circle-agent/60 px-2.5 py-0.5 text-[11px] text-circle-agent"
          >
            + Enroll your agent
          </button>
        )}
        {!closed && sandbox.practicePubkey === null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => store.addPracticeSeat(circle.circleId, card.cardId))}
            className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground"
            title="A labeled, simulated second agent so the card is testable solo"
          >
            + Practice seat
          </button>
        )}
      </div>

      {/* paused / disabled banners — every stopped state says why (§3.1) */}
      {paused && (
        <div className="mx-3 mb-2 rounded-md border border-emerald-700/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs flex items-center gap-2">
          <span>
            <b>Paused</b> — {enr?.pauseReason ?? "paused by you"}. Nothing posts until you resume.
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded border border-emerald-600 px-2 py-0.5 text-emerald-600 font-medium"
            onClick={() => void run(() => store.resumeSandbox(circle.circleId, card.cardId))}
          >
            <Play className="w-3 h-3 inline mr-1" />
            Resume
          </button>
        </div>
      )}
      {!sandbox.generationEnabled && enrolled && !closed && (
        <div className="mx-3 mb-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          Agent generation is off on this node (<code>circles.sandbox.enabled</code>). Your
          enrollment stands; moves by hand still work.
        </div>
      )}

      {/* verdict band — the glance (§3.2.3) */}
      <div className="mx-3 mb-2 flex items-center gap-3 text-[11px] text-muted-foreground border-y py-1">
        <span className="tabular-nums">
          <b className="text-foreground">{session.moves.length}</b> moves ·{" "}
          <b className="text-foreground">{deltas}</b> deltas
        </span>
        <span>every move signed</span>
        {!closed && session.waitingOn.length > 0 && (
          <span className="text-amber-600 font-medium">
            waiting on {session.waitingOn.map(who).join(", ")}
          </span>
        )}
      </div>

      {/* artifact above feed: the options + votes */}
      {session.options.length > 0 && (
        <div className="mx-3 mb-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
            Options on the table
          </div>
          {session.options.map((o) => {
            const voters = session.votes[o.optionId] ?? [];
            const mine = selfPubkey ? voters.includes(selfPubkey) : false;
            return (
              <div key={o.optionId} className="flex items-center gap-2 py-1 border-t text-sm">
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {voters.length > 0 ? voters.map(who).join(" · ") : "no votes yet"}
                </span>
                {!closed && !mine && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        store.sandboxMove(circle.circleId, card.cardId, "vote", {
                          optionId: o.optionId,
                        }),
                      )
                    }
                    className="shrink-0 rounded border border-emerald-600 px-2 py-0.5 text-[11px] text-emerald-600 font-medium"
                  >
                    Vote
                  </button>
                )}
                {mine && (
                  <span className="shrink-0 text-[11px] text-emerald-600 font-medium">
                    <Check className="w-3 h-3 inline" /> you
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* the propose tray: your agent's move awaiting YOUR tap (I7) */}
      {proposal && !closed && (
        <div className="mx-3 mb-2 rounded-md border border-circle-agent/50 bg-circle-agent/5 p-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-circle-agent mb-1">
            <Sparkles className="w-3 h-3 inline mr-1" />
            Your agent proposes · needs your tap
          </div>
          <div className="text-sm whitespace-pre-wrap break-words">{proposal.content}</div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  store.publishDraft(circle.circleId, proposal.draftId, proposal.content),
                )
              }
              className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white"
            >
              Approve &amp; post
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => store.discardDraft(circle.circleId, proposal.draftId))}
              className="rounded border px-2.5 py-1 text-[11px]"
            >
              <X className="w-3 h-3 inline" /> Discard
            </button>
            <span className="text-[10px] text-muted-foreground ml-auto">
              nothing posts unseen — discarded proposals never leave this node
            </span>
          </div>
        </div>
      )}

      {/* move feed: diffs, attributed, agent-labeled (R18) */}
      <div className="px-3 pb-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">
          Moves
        </div>
        {session.moves.length === 0 && (
          <div className="text-xs text-muted-foreground pb-1">
            No moves yet.{" "}
            {session.speakers.length === 0
              ? "Enroll an agent or add one by hand below."
              : session.myTurn
                ? "It is your seat's turn."
                : `Waiting on ${session.waitingOn.map(who).join(", ") || "the next speaker"}.`}
          </div>
        )}
        {session.moves.map((m) => (
          <div key={m.eventHash} className="flex gap-2 py-1 text-sm">
            <div
              className={`w-0.5 rounded self-stretch shrink-0 ${
                m.kind === "option.add" ? "bg-emerald-500" : "bg-circle-agent"
              }`}
            />
            <div className="min-w-0">
              <div className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{who(m.authorPubkey)}</span>
                {m.agentAuthored && <span className="text-circle-agent">&apos;s agent</span>}
                {" · "}round {m.round + 1} · {m.kind}
                {m.authors.length > 1 && (
                  <span>
                    {" "}
                    · derived from{" "}
                    {m.authors
                      .filter((a) => a !== m.authorPubkey)
                      .map(who)
                      .join(", ")}
                  </span>
                )}
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

      {/* human composer (§2's "join in" half) */}
      {!closed && (
        <div className="px-3 pb-2">
          {composer === null ? (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setComposer("constraint")}
                className="text-circle-you font-medium"
              >
                + Constraint
              </button>
              <button
                type="button"
                onClick={() => setComposer("option")}
                className="text-circle-you font-medium"
              >
                + Option
              </button>
              <span className="text-muted-foreground ml-auto">
                you can play by hand — no agent required
              </span>
            </div>
          ) : (
            <div className="rounded-md border p-2 space-y-1.5">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoFocus
                placeholder={
                  composer === "constraint"
                    ? "A constraint or preference, e.g. “free June 19–26, cap $200/night”"
                    : "An option to put on the table, e.g. “Cabin B — $185/night”"
                }
                className="w-full bg-transparent text-sm outline-none"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    composer === "constraint" ? void postConstraint() : void postOption()
                  }
                  className="rounded bg-circle-you px-2.5 py-1 text-[11px] font-semibold text-circle-you-fg"
                >
                  Post
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
      )}

      {/* footer: pause (one tap, no confirm) + close + oversight drawer */}
      <div className="border-t bg-background/40">
        <div className="px-3 py-1.5 flex items-center gap-2">
          {enrolled && !paused && !closed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => store.pauseSandbox(circle.circleId, card.cardId))}
              className="rounded bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white"
            >
              <Pause className="w-3 h-3 inline mr-0.5" /> Pause
            </button>
          )}
          {!closed && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => store.closeSandbox(circle.circleId, card.cardId, "done"))
              }
              className="rounded border px-2.5 py-1 text-[11px]"
            >
              Close session
            </button>
          )}
          {closed && session.closed && (
            <span className="text-[11px] text-muted-foreground">
              {CLOSE_LABELS[session.closed.reason] ?? session.closed.reason} · by{" "}
              {who(session.closed.byPubkey)}
            </span>
          )}
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            className="ml-auto text-[10px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1"
          >
            <ChevronDown
              className={`w-3 h-3 transition-transform ${drawerOpen ? "rotate-180" : ""}`}
            />
            Your agent · oversight
          </button>
        </div>

        {drawerOpen && (
          <div className="px-3 pb-3 space-y-2 text-xs">
            <div className="rounded-md border p-2">
              <div className="font-semibold mb-1">
                Consent <span className="text-muted-foreground font-normal">· node-local</span>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={!enrolled}
                    onChange={() =>
                      void run(() => store.enrollSandbox(circle.circleId, card.cardId, "off"))
                    }
                  />
                  Off — watch only
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={enrolled}
                    onChange={() =>
                      void run(() =>
                        store.enrollSandbox(circle.circleId, card.cardId, "propose", { guidance }),
                      )
                    }
                  />
                  Propose — every move waits for your tap
                </label>
                <span className="text-muted-foreground" title="Ships in P2 behind its own opt-in">
                  Auto — not yet
                </span>
              </div>
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                onBlur={() => {
                  if (enrolled && guidance !== (enr?.guidance ?? "")) {
                    void run(() =>
                      store.enrollSandbox(circle.circleId, card.cardId, "propose", { guidance }),
                    );
                  }
                }}
                placeholder="Steer privately, e.g. “free June 19–26; nothing over $200/night”. Never leaves this node."
                rows={2}
                className="mt-1.5 w-full resize-none rounded border bg-transparent px-2 py-1 outline-none"
              />
              <div className="mt-1 text-[10px] text-muted-foreground">
                Peers see only your mode. Guidance and budgets stay on this node.
              </div>
            </div>
            {enr && (
              <div className="rounded-md border p-2">
                <div className="font-semibold mb-1">
                  Budgets{" "}
                  <span className="text-muted-foreground font-normal">· only you refill</span>
                </div>
                <div className="flex items-center justify-between tabular-nums">
                  <span>Turns</span>
                  <span>
                    {enr.turnsUsed}/{enr.turnBudget}
                  </span>
                </div>
                <div className="h-1 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full bg-circle-agent"
                    style={{
                      width: `${Math.min(100, (enr.turnsUsed / Math.max(1, enr.turnBudget)) * 100)}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between tabular-nums">
                  <span>Tokens</span>
                  <span>
                    {Math.round(enr.tokensUsed / 1000)}k/{Math.round(enr.tokenBudget / 1000)}k
                  </span>
                </div>
                <div className="h-1 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full bg-circle-agent"
                    style={{
                      width: `${Math.min(100, (enr.tokensUsed / Math.max(1, enr.tokenBudget)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
