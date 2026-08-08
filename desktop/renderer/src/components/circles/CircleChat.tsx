import { Bell, Pin, Reply, Send, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { unwrapForDisplay } from "../../lib/external-content-display";
import { cn } from "../../lib/utils";
import {
  memberName,
  useCirclesStore,
  type Circle,
  type CircleMessage,
} from "../../stores/circles-store";
import { AgentDraftCard } from "./AgentDraftCard";
import { CanvasLiveStrip } from "./CanvasActivity";
import { circleIdentity } from "./circle-identity";
import { CircleMessageList } from "./CircleMessageList";
import { FrozenCircleBanner } from "./FrozenCircleBanner";
import { InviteTrustPrompt, type InvitePreview } from "./InviteTrustPrompt";
import { PendingOutboundCard } from "./PendingOutboundCard";

// PLAN-36 Phase A: the center chat pane — header, conversation stream, composer.
// A3 adds reply-to (a compact quote banner + the parent's envelope id on send).
// Phase B: @agent in a message summons the reader's OWN agent, whose draft
// appears above the composer as a private consent card (AgentDraftCard).

interface Props {
  circle: Circle;
  selfPubkey: string | undefined;
}

function replyLabel(
  m: { direction: string; authorPubkey: string; agentAuthored?: boolean },
  selfPubkey: string | undefined,
  members: Circle["members"],
) {
  const isSelf = m.direction === "out" || m.authorPubkey === selfPubkey;
  const found = members.find((x) => x.memberPubkey === m.authorPubkey);
  const owner = isSelf ? "You" : found ? memberName(found) : "friend";
  // Review #5: provenance carries into the pinned bar too.
  return m.agentAuthored ? (isSelf ? "Your agent" : `${owner}'s agent`) : owner;
}

export function CircleChat({ circle, selfPubkey }: Props) {
  const messages = useCirclesStore((s) => s.messagesByCircle[circle.circleId]);
  const annotations = useCirclesStore((s) => s.annotationsByCircle[circle.circleId]);
  const readFrontier = useCirclesStore((s) => s.readFrontierByCircle[circle.circleId]);
  const historyExhausted = useCirclesStore((s) => s.historyExhaustedByCircle[circle.circleId]);
  const loadOlderMessages = useCirclesStore((s) => s.loadOlderMessages);
  const agentDrafts = useCirclesStore((s) => s.draftsByCircle[circle.circleId]);
  const pendingOutbound = useCirclesStore((s) => s.outboundByCircle[circle.circleId]);
  const send = useCirclesStore((s) => s.send);
  const react = useCirclesStore((s) => s.react);
  const setPinned = useCirclesStore((s) => s.setPinned);
  const deleteMessage = useCirclesStore((s) => s.deleteMessage);
  const putCard = useCirclesStore((s) => s.putCard);
  const requestChatDraft = useCirclesStore((s) => s.requestChatDraft);
  const setAgentDrafts = useCirclesStore((s) => s.setAgentDrafts);
  const steerAgent = useCirclesStore((s) => s.steerAgent);
  const setNotice = useCirclesStore((s) => s.setNotice);
  const sandbox = useCirclesStore((s) => s.sandboxByCircle[circle.circleId]);
  const joinInvite = useCirclesStore((s) => s.joinInvite);
  const inviteInfo = useCirclesStore((s) => s.inviteInfo);
  // Join-from-message consent: parse + signature-verify the code first so the
  // human sees who is REALLY asking (the code's signer can differ from the
  // message sender), then join only on their explicit tap.
  const [joinPrompt, setJoinPrompt] = useState<InvitePreview | null>(null);

  const previewInvite = async (code: string) => {
    const info = await inviteInfo(code);
    if (info) setJoinPrompt({ code, ...info });
  };
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<CircleMessage | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  // Phase D: message delete confirms IN-APP (native confirm() is gone) and
  // pins jump to their message (the whole point of a pin).
  const [confirmDelete, setConfirmDelete] = useState<{ m: CircleMessage; own: boolean } | null>(
    null,
  );
  const [focusEnvelopeId, setFocusEnvelopeId] = useState<string | null>(null);
  // Summon-UX: when the human explicitly asked for a draft (typed @agent or
  // tapped Ask my agent), the response must be LOUD, not quiet — show a
  // drafting indicator and auto-open the tray when the draft lands.
  // Attribution is a COUNTER (drafts carry no request ids): each arriving
  // draft retires one outstanding summon, so a dismissed wait can no longer
  // mis-clear a later summon's indicator (d638276 review #8).
  const [awaitingCount, setAwaitingCount] = useState(0);
  const [awaitingDraftSince, setAwaitingDraftSince] = useState<number | null>(null);
  const chatDraftCount = (agentDrafts ?? []).filter((d) => !d.targetSlot).length;
  const [seenDraftCount, setSeenDraftCount] = useState(chatDraftCount);

  useEffect(() => {
    const arrived = chatDraftCount - seenDraftCount;
    if (arrived === 0) return;
    setSeenDraftCount(chatDraftCount);
    // Discards shrink the count; only growth retires outstanding summons.
    if (arrived < 0 || awaitingCount === 0) return;
    const remaining = Math.max(0, awaitingCount - arrived);
    setAwaitingCount(remaining);
    setTrayOpen(true);
    setAwaitingDraftSince(remaining === 0 ? null : Date.now());
  }, [chatDraftCount, seenDraftCount, awaitingCount]);

  // Generation runs on a ~15s sweep + one LLM call; give up quietly after
  // 2 minutes of silence rather than spinning forever (rate-limited / off).
  useEffect(() => {
    if (awaitingDraftSince === null) return;
    const t = setTimeout(() => {
      setAwaitingCount(0);
      setAwaitingDraftSince(null);
    }, 120_000);
    return () => clearTimeout(t);
  }, [awaitingDraftSince]);

  const beginAwaitingDraft = () => {
    setAwaitingCount((c) => c + 1);
    setAwaitingDraftSince((s) => s ?? Date.now());
  };

  // Phase C: the working indicator shows honest elapsed time (Buzz-style
  // "how long has it actually been") and carries its own dismiss.
  const [draftElapsed, setDraftElapsed] = useState(0);
  useEffect(() => {
    if (awaitingDraftSince === null) {
      setDraftElapsed(0);
      return;
    }
    const tick = () =>
      setDraftElapsed(Math.max(0, Math.floor((Date.now() - awaitingDraftSince) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [awaitingDraftSince]);

  const askMyAgent = async () => {
    if (awaitingDraftSince !== null) return;
    const ok = await requestChatDraft(circle.circleId);
    if (ok) beginAwaitingDraft();
  };

  const peerCount = circle.members.filter((m) => !m.isSelf).length;
  // Mirror of the server's detectAgentSummon token (agent-drafts.ts).
  const SUMMON_RE = /(^|[^\w@])@agents?\b/i;

  // Phase D: toggle one emoji in MY reaction set on a message.
  const toggleReaction = (m: CircleMessage, emoji: string) => {
    if (!m.envelopeId) return;
    const mine =
      annotations?.reactions[m.envelopeId]?.find((r) => r.authorPubkey === selfPubkey)?.emojis ??
      [];
    const next = mine.includes(emoji) ? mine.filter((e) => e !== emoji) : [...mine, emoji];
    void react(circle.circleId, m.envelopeId, next);
  };

  // Server-resolved (no window limit — a pin's point is surfacing OLD
  // messages); fall back to the local buffer for older gateways.
  const pinnedMessages =
    annotations?.pinnedMessages ??
    (annotations?.pins ?? [])
      .map((envId) => (messages ?? []).find((m) => m.envelopeId === envId))
      .filter((m): m is CircleMessage => !!m)
      .map((m) => ({
        envelopeId: m.envelopeId ?? m.messageId,
        authorPubkey: m.authorPubkey,
        direction: m.direction,
        agentAuthored: m.agentAuthored,
        content: m.content,
        createdAt: m.createdAt,
      }));

  const submit = async () => {
    if (!draft.trim() || sending) return;
    // /steer <text>: private guidance for YOUR OWN agent's canvas work.
    // Intercepted client-side and routed to the steer RPC — it is never sent
    // to the circle (decision 5: steering is private; and it is first-party
    // text, so the §3.3 chat/canvas asymmetry is untouched).
    const steerMatch = draft.trim().match(/^\/steer\s+([\s\S]+)/i);
    if (steerMatch) {
      setSending(true);
      const ok = await steerAgent(circle.circleId, steerMatch[1].trim());
      setSending(false);
      if (ok) {
        setDraft("");
        setNotice("Guidance saved — your agent uses it on its next canvas turn. (Never posted.)");
      }
      return;
    }
    const summoned = SUMMON_RE.test(draft);
    setSending(true);
    const ok = await send(circle.circleId, draft, replyTo?.envelopeId ?? undefined);
    setSending(false);
    if (ok) {
      setDraft("");
      setReplyTo(null);
      // A summon the human just sent must not vanish into silence — start
      // the drafting indicator (their own agent queues at send time).
      if (summoned) beginAwaitingDraft();
    }
  };

  return (
    <section className="flex-1 flex flex-col min-w-0">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b">
        <div className="flex items-center gap-2.5 min-w-0">
          {(() => {
            // Phase B: the same identity as the rail tile, so the pane and the
            // rail read as one thing.
            const id = circleIdentity(circle.circleId, circle.name);
            return (
              <div
                aria-hidden="true"
                className="w-7 h-7 rounded-lg shrink-0 grid place-items-center text-xs font-bold text-white"
                style={{ background: id.gradient }}
              >
                {id.emoji ?? id.initials}
              </div>
            );
          })()}
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="font-semibold text-base truncate">{circle.name}</span>
            <span className="text-xs text-muted-foreground">
              {peerCount === 1 ? "1 friend" : `${peerCount} friends`}
              {circle.status !== "active" && ` · ${circle.status}`}
            </span>
          </div>
        </div>
        {(() => {
          // Phase C: the posture chip is REAL — it reads your own roster row
          // (the server computes it from the drafts switch + whether a draft
          // model is actually wired) and clicking it flips the switch.
          const posture = circle.members.find((m) => m.isSelf)?.agentPosture ?? null;
          if (!posture) {
            // Pre-posture gateway (no self-row agentPosture): keep the static
            // consent indicator those builds always showed — losing the
            // "agents are summon-only, drafts are private" statement entirely
            // would be the real regression (d638276 review #9).
            return (
              <span
                title="Agents in circles are summon-only by design; drafts stay private until you publish. Upgrade the gateway to control this from here."
                className="text-2xs font-medium px-2 py-1 rounded-full border text-muted-foreground whitespace-nowrap"
              >
                Agents: summon-only
              </span>
            );
          }
          const on = posture !== "off";
          return (
            <button
              type="button"
              onClick={() => void setAgentDrafts(!on)}
              title={
                on
                  ? "Your agent answers only when summoned (@agent or ✨), and drafts are private until you publish. Click to turn agent drafts off."
                  : "Agent drafts are off — summons do nothing on this node. Click to enable summon-only drafting."
              }
              className={cn(
                "text-2xs font-medium px-2 py-1 rounded-full border whitespace-nowrap hover:text-foreground",
                on ? "text-circle-agent border-circle-agent/40" : "text-muted-foreground",
              )}
            >
              Agents: {on ? posture : "off"}
            </button>
          );
        })()}
      </header>

      {pinnedMessages.length > 0 && (
        <div className="mx-3 mt-2 rounded-lg border border-circle-you/20 bg-circle-you-soft/60 text-xs">
          <button
            type="button"
            onClick={() => setShowPins((v) => !v)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-muted-foreground hover:text-foreground"
          >
            <Pin className="w-3 h-3 text-circle-you shrink-0" />
            <span className="font-medium">
              {pinnedMessages.length} pinned {pinnedMessages.length === 1 ? "message" : "messages"}
            </span>
            <span className="ml-auto">{showPins ? "hide" : "show"}</span>
          </button>
          {showPins && (
            <div className="px-3 pb-2 space-y-1.5">
              {pinnedMessages.map((m) => (
                <button
                  key={m.envelopeId}
                  type="button"
                  onClick={() => setFocusEnvelopeId(m.envelopeId)}
                  title="Jump to this message"
                  className="flex items-baseline gap-2 min-w-0 w-full text-left hover:text-foreground"
                >
                  <span className="font-medium shrink-0">
                    {replyLabel(m, selfPubkey, circle.members)}
                  </span>
                  <span className="truncate">{unwrapForDisplay(m.content).text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <CircleMessageList
        messages={messages}
        members={circle.members}
        selfPubkey={selfPubkey}
        readFrontier={readFrontier}
        onLoadOlder={() => loadOlderMessages(circle.circleId)}
        hasMoreHistory={!historyExhausted}
        onReply={setReplyTo}
        annotations={annotations}
        onToggleReaction={circle.status === "active" ? toggleReaction : undefined}
        onJoinInvite={(code) => void previewInvite(code)}
        onTogglePin={
          circle.status === "active"
            ? (m, pinned) => {
                if (m.envelopeId) void setPinned(circle.circleId, m.envelopeId, pinned);
              }
            : undefined
        }
        onAddToCanvas={
          circle.status === "active"
            ? (m, text) => {
                // The chat scrolls away; the canvas is where things stop
                // scrolling. Title = the author, text = what they said.
                const found = circle.members.find((mm) => mm.memberPubkey === m.authorPubkey);
                const author =
                  m.direction === "out" || m.authorPubkey === selfPubkey
                    ? "You"
                    : found
                      ? memberName(found) // petname-first, like every surface
                      : "friend";
                // The ledger caps card text at 4000 chars; truncate visibly
                // rather than letting the tail vanish silently.
                const body = text.length > 3990 ? `${text.slice(0, 3990)}\u2026 [truncated]` : text;
                void putCard(circle.circleId, `From ${author}`, body);
              }
            : undefined
        }
        focusEnvelopeId={focusEnvelopeId}
        onFocusConsumed={() => setFocusEnvelopeId(null)}
        onDelete={(m, own) => {
          if (!m.envelopeId) return;
          setConfirmDelete({ m, own });
        }}
      />

      {circle.status === "frozen" && <FrozenCircleBanner circle={circle} />}

      {/* §3.2.8: chat is the venue — the canvas's conversational surface
          (proposals, narration, pauses, agreement, removals) renders here,
          derived per-viewer, each item chipped to its card. */}
      <CanvasLiveStrip circle={circle} selfPubkey={selfPubkey} />

      {/* The quiet tray (mockup pin 2's "noticed N things — nothing posted"):
          every consent surface — §5.3 approval cards + Phase B chat drafts —
          collapses behind one calm summary line. Nothing has been posted;
          expanding shows the cards exactly as before. */}
      {(() => {
        const chatDrafts = (agentDrafts ?? []).filter((d) => !d.targetSlot);
        const noticed = (pendingOutbound ?? []).length + chatDrafts.length;
        if (noticed === 0) return null;
        return (
          <div className="mx-3 mb-1 motion-enter-conversation rounded-lg border border-dashed text-xs">
            <button
              type="button"
              onClick={() => setTrayOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground"
            >
              {/* Review #8: an awaiting §5.3 card is CONSENT-needed (amber),
                  not mere agent activity (violet) — and it expires. */}
              <Bell
                className={cn(
                  "w-3.5 h-3.5 shrink-0",
                  (pendingOutbound ?? []).length > 0 ? "text-circle-consent" : "text-circle-agent",
                )}
              />
              <span>
                Your agent {noticed === 1 ? "noticed 1 thing" : `noticed ${noticed} things`} —
                nothing posted
                {(pendingOutbound ?? []).length > 0 &&
                  ` · ${(pendingOutbound ?? []).length === 1 ? "1 needs" : `${(pendingOutbound ?? []).length} need`} approval`}
              </span>
              <span className="ml-auto">{trayOpen ? "hide" : "review"}</span>
            </button>
            {trayOpen && (
              <div className="pb-1.5">
                {(pendingOutbound ?? []).map((p) => (
                  <PendingOutboundCard key={p.id} pending={p} />
                ))}
                {chatDrafts.map((d) => (
                  <AgentDraftCard
                    key={d.draftId}
                    draft={d}
                    circle={circle}
                    selfPubkey={selfPubkey}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {replyTo && (
        <div className="mx-3 -mb-1 flex items-center gap-2 text-xs text-muted-foreground border rounded-t-lg bg-muted/50 px-3 py-1.5">
          <Reply className="w-3.5 h-3.5 shrink-0" />
          <span className="shrink-0 font-medium">
            Replying to {replyLabel(replyTo, selfPubkey, circle.members)}
          </span>
          <span className="truncate opacity-80">{unwrapForDisplay(replyTo.content).text}</span>
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

      {confirmDelete && (
        <div className="mx-3 mb-1 motion-enter-conversation rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs space-y-1.5">
          <p>
            {confirmDelete.own
              ? "Delete this message? It is removed here and on your friends' devices (as far as their nodes cooperate)."
              : "Hide this message on this device? Other members still see it."}
          </p>
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="text-muted-foreground px-2 py-0.5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const { m, own } = confirmDelete;
                setConfirmDelete(null);
                if (m.envelopeId) void deleteMessage(circle.circleId, m.envelopeId, own);
              }}
              className="font-medium px-2.5 py-0.5 rounded bg-destructive text-white"
            >
              {confirmDelete.own ? "Delete" : "Hide"}
            </button>
          </div>
        </div>
      )}

      {joinPrompt && (
        <div className="mx-3 mb-1 motion-enter-conversation">
          <InviteTrustPrompt
            preview={joinPrompt}
            onCancel={() => setJoinPrompt(null)}
            onJoin={() => {
              const code = joinPrompt.code;
              setJoinPrompt(null);
              void joinInvite(code);
            }}
          />
        </div>
      )}

      {/* Summon-UX: an explicitly requested draft is loud — the human sees
          their agent working instead of a 15-45s silence. */}
      {awaitingDraftSince !== null && (
        <div className="mx-3 -mb-1 motion-enter-conversation flex items-center gap-2 text-xs text-circle-agent border border-circle-agent/30 rounded-t-lg bg-circle-agent-soft/40 px-3 py-1.5">
          <Sparkles className="w-3.5 h-3.5 shrink-0 animate-pulse" />
          <span className="min-w-0">
            Your agent is drafting{awaitingCount > 1 ? ` ×${awaitingCount}` : ""}{" "}
            <span className="tabular-nums">({draftElapsed}s)</span> — it lands above the composer,
            private to you, and nothing posts until you approve it.
          </span>
          <button
            type="button"
            onClick={() => {
              setAwaitingCount(0);
              setAwaitingDraftSince(null);
            }}
            aria-label="Stop waiting for the draft"
            title="Stop waiting — if the draft still lands, it goes to the quiet tray."
            className="ml-auto shrink-0 hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="m-3 rounded-xl border bg-card flex items-end gap-2 p-2">
        {circle.status === "active" && (
          <button
            type="button"
            onClick={() => void askMyAgent()}
            disabled={awaitingDraftSince !== null}
            title="Ask your agent to draft a reply to this conversation. Private: nothing is posted to the circle until you review and publish. Typing @agent in a message instead invites EVERYONE's agents to draft for their humans."
            aria-label="Ask my agent to draft a reply"
            className="shrink-0 w-8 h-8 rounded-lg grid place-items-center text-circle-agent bg-circle-agent-soft/60 hover:bg-circle-agent-soft disabled:opacity-40"
          >
            <Sparkles className="w-4 h-4" />
          </button>
        )}
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
              ? "Message the circle… @agent asks everyone's agents"
              : "This circle is frozen — messages are paused"
          }
          disabled={circle.status !== "active"}
          className="flex-1 resize-none bg-transparent text-sm outline-none px-1 py-1.5 max-h-32 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!draft.trim() || sending || circle.status !== "active"}
          className="w-8 h-8 rounded-lg grid place-items-center bg-circle-you text-circle-you-fg disabled:opacity-40"
          aria-label="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </section>
  );
}
