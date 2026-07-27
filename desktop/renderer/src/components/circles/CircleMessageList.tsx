import { Pin, Reply, ShieldCheck, SmilePlus, StickyNote, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { unwrapForDisplay } from "../../lib/external-content-display";
import { cn } from "../../lib/utils";
import {
  memberName,
  type CircleMember,
  type CircleMessage,
  type MessageAnnotations,
} from "../../stores/circles-store";

// Phase D reactions: a small fixed palette keeps the picker one tap deep.
const REACTION_PALETTE = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

// PLAN-36 Phase A: the circle conversation stream. New rendering (not the
// two-party chat MessageList) — every row carries author identity and a
// human/you chip, oldest-first, auto-scrolled to the newest. Agent-authored
// styling + reactions/reply-to land in Phase B/A-later; the row is structured
// to grow into them.

const AVATAR_COLORS = ["#0f9d68", "#3a5bd9", "#c9871a", "#8b5cf6", "#d6336c", "#0c8599", "#e8590c"];

function colorFor(pubkey: string): string {
  let h = 0;
  for (let i = 0; i < pubkey.length; i += 1) h = (h * 31 + pubkey.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] as string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return ((parts[0] as string)[0] + (parts[1] as string)[0]).toUpperCase();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// A pasted/delivered invite code in a message body (bbc1.<base64url>).
// Detection only — tapping Join runs the full signature-checked join
// ceremony server-side; the code is data until the human consents.
const INVITE_CODE_RE = /\bbbc1\.[A-Za-z0-9_-]{20,}/;

interface Props {
  messages: CircleMessage[];
  members: CircleMember[];
  selfPubkey: string | undefined;
  onReply: (m: CircleMessage) => void;
  /** Phase D: reactions + pins folded from the event log. */
  annotations?: MessageAnnotations;
  /** Toggle ONE emoji in our reaction set on a message. */
  onToggleReaction?: (m: CircleMessage, emoji: string) => void;
  /** One-tap join for an invite code detected in an inbound message. */
  onJoinInvite?: (code: string) => void;
  onTogglePin?: (m: CircleMessage, pinned: boolean) => void;
  /**
   * Delete: own messages retract everywhere (honest peers tombstone too);
   * others' messages are hidden on this node only. The handler confirms.
   */
  onDelete?: (m: CircleMessage, own: boolean) => void;
  /** Promote a message to a canvas note card (unwrapped display text). */
  onAddToCanvas?: (m: CircleMessage, text: string) => void;
}

export function CircleMessageList({
  messages,
  members,
  selfPubkey,
  onReply,
  annotations,
  onToggleReaction,
  onJoinInvite,
  onTogglePin,
  onDelete,
  onAddToCanvas,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.memberPubkey, memberName(m));
    return (pubkey: string) => map.get(pubkey) ?? "friend";
  }, [members]);

  // Resolve a reply's parent locally by its shared envelope id (A3).
  const byEnvelope = useMemo(() => {
    const map = new Map<string, CircleMessage>();
    for (const m of messages) if (m.envelopeId) map.set(m.envelopeId, m);
    return map;
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No messages yet. Say hello.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      {messages.map((m) => {
        const isSelf = m.direction === "out" || m.authorPubkey === selfPubkey;
        // Mockup pin 2: agent-written text is attributed to the AGENT, bound
        // to its owner — "Maya's agent", never plain "Maya".
        const isAgent = m.agentAuthored === true;
        const owner = isSelf ? "You" : nameOf(m.authorPubkey);
        const name = isAgent ? (isSelf ? "Your agent" : `${owner}'s agent`) : owner;
        const color = isSelf ? "#3a5bd9" : colorFor(m.authorPubkey);
        const parent = m.replyTo ? byEnvelope.get(m.replyTo) : undefined;
        // Inbound content is stored security-wrapped for agent consumers;
        // humans get the body plus a screened indicator, not the plumbing.
        const display = unwrapForDisplay(m.content);
        // Phase D: fold this message's reactions into emoji -> reactors.
        const reactionSets = (m.envelopeId && annotations?.reactions[m.envelopeId]) || [];
        const byEmoji = new Map<string, string[]>();
        for (const r of reactionSets) {
          for (const e of r.emojis) {
            const list = byEmoji.get(e) ?? [];
            list.push(r.authorPubkey);
            byEmoji.set(e, list);
          }
        }
        const myEmojis = new Set(
          reactionSets.find((r) => r.authorPubkey === selfPubkey)?.emojis ?? [],
        );
        const isPinned = !!m.envelopeId && (annotations?.pins ?? []).includes(m.envelopeId);
        const toggle = (emoji: string) => {
          if (!onToggleReaction) return;
          setPickerFor(null);
          onToggleReaction(m, emoji);
        };
        if (m.deleted) {
          return (
            <div key={m.messageId} className="flex gap-3 opacity-60">
              <div className="w-8 h-8 rounded-lg shrink-0 grid place-items-center text-xs text-muted-foreground border border-border/40">
                <Trash2 className="w-3.5 h-3.5" aria-label="deleted" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-muted-foreground">
                    {isSelf ? "You" : nameOf(m.authorPubkey)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{fmtTime(m.createdAt)}</span>
                </div>
                <div className="text-sm italic text-muted-foreground">
                  {m.deletedByMe ? "hidden by you" : "message deleted"}
                </div>
              </div>
            </div>
          );
        }
        return (
          <div key={m.messageId} className="group relative flex gap-3">
            <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center">
              {m.envelopeId && onToggleReaction && (
                <button
                  type="button"
                  onClick={() => setPickerFor(pickerFor === m.messageId ? null : m.messageId)}
                  aria-label="Add reaction"
                  className="text-muted-foreground hover:text-foreground p-1 rounded"
                >
                  <SmilePlus className="w-3.5 h-3.5" />
                </button>
              )}
              {m.envelopeId && onTogglePin && (
                <button
                  type="button"
                  onClick={() => onTogglePin(m, !isPinned)}
                  aria-label={isPinned ? "Unpin message" : "Pin message"}
                  className={cn(
                    "p-1 rounded hover:text-foreground",
                    isPinned ? "text-circle-you" : "text-muted-foreground",
                  )}
                >
                  <Pin className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onReply(m)}
                aria-label={`Reply to ${name}`}
                className="text-muted-foreground hover:text-foreground p-1 rounded"
              >
                <Reply className="w-3.5 h-3.5" />
              </button>
              {onAddToCanvas && (
                <button
                  type="button"
                  onClick={() => onAddToCanvas(m, display.text)}
                  aria-label="Add to canvas"
                  title="Add to the shared canvas"
                  className="text-muted-foreground hover:text-foreground p-1 rounded"
                >
                  <StickyNote className="w-3.5 h-3.5" />
                </button>
              )}
              {m.envelopeId && onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(m, isSelf)}
                  aria-label={isSelf ? "Delete message" : "Hide message for me"}
                  title={isSelf ? "Delete for everyone" : "Hide on this device"}
                  className="text-muted-foreground hover:text-red-400 p-1 rounded"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {pickerFor === m.messageId && (
              <div className="absolute right-0 top-6 z-10 flex gap-1 rounded-lg border bg-popover p-1 shadow-md">
                {REACTION_PALETTE.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => toggle(e)}
                    aria-label={`React ${e}`}
                    className={cn(
                      "text-base leading-none p-1 rounded hover:bg-muted",
                      myEmojis.has(e) && "bg-circle-you-soft",
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
            {isAgent ? (
              <div
                aria-label="agent message"
                className="w-8 h-8 rounded-lg shrink-0 grid place-items-center text-sm border border-circle-agent bg-circle-agent-soft text-circle-agent"
              >
                ◆
              </div>
            ) : (
              <div
                className="w-8 h-8 rounded-lg shrink-0 grid place-items-center text-xs font-bold text-white"
                style={{ background: color }}
              >
                {initials(name)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              {m.replyTo && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5 min-w-0">
                  <Reply className="w-3 h-3 shrink-0" />
                  {parent ? (
                    <>
                      <span className="font-medium shrink-0">
                        {(() => {
                          // Review #5: provenance carries into reply quotes —
                          // replying to "Maya's agent" must not quote "Maya".
                          const pSelf =
                            parent.direction === "out" || parent.authorPubkey === selfPubkey;
                          const pOwner = pSelf ? "You" : nameOf(parent.authorPubkey);
                          return parent.agentAuthored
                            ? pSelf
                              ? "Your agent"
                              : `${pOwner}'s agent`
                            : pOwner;
                        })()}
                      </span>
                      {parent.deleted ? (
                        <em className="truncate opacity-60">message deleted</em>
                      ) : (
                        <span className="truncate opacity-80">
                          {unwrapForDisplay(parent.content).text}
                        </span>
                      )}
                    </>
                  ) : (
                    <span>replied to an earlier message</span>
                  )}
                </div>
              )}
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm font-semibold">{name}</span>
                {isAgent && (
                  <span className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-circle-agent-soft text-circle-agent">
                    agent
                  </span>
                )}
                {isSelf && !isAgent && (
                  <span className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-circle-you-soft text-circle-you">
                    you
                  </span>
                )}
                {m.kind !== "message" && (
                  <span className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                    {m.kind}
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground">{fmtTime(m.createdAt)}</span>
                {isPinned && (
                  <span title="Pinned for the circle" className="text-circle-you">
                    <Pin className="w-3 h-3" aria-label="pinned" />
                  </span>
                )}
                {display.wasWrapped && (
                  <span
                    title="Screened on receipt — your agent treats this as untrusted peer content"
                    className="text-muted-foreground/70"
                  >
                    <ShieldCheck className="w-3 h-3" aria-label="screened" />
                  </span>
                )}
              </div>
              {isAgent ? (
                // The mockup's .agentmsg treatment: a quiet violet-edged card
                // so agent words never blend into human conversation.
                <div className="mt-0.5 rounded-md border border-border border-l-2 border-l-circle-agent bg-card px-2.5 py-1.5 text-sm whitespace-pre-wrap break-words">
                  {display.text}
                </div>
              ) : m.kind === "system" ? (
                // §5.5 system notices (e.g. a member removal a peer announced):
                // muted + italic so a node-level statement never reads as
                // something the person conversationally said. The `system`
                // kind badge above names the category.
                <div className="text-sm italic text-muted-foreground whitespace-pre-wrap break-words">
                  {display.text}
                </div>
              ) : (
                <div className="text-sm whitespace-pre-wrap break-words">{display.text}</div>
              )}
              {(() => {
                if (!onJoinInvite || isSelf) return null;
                const code = display.text.match(INVITE_CODE_RE)?.[0];
                if (!code) return null;
                return (
                  <button
                    type="button"
                    onClick={() => onJoinInvite(code)}
                    className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded bg-circle-you text-circle-you-fg"
                  >
                    Join this circle
                  </button>
                );
              })()}
              {byEmoji.size > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {[...byEmoji.entries()].map(([emoji, reactors]) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => toggle(emoji)}
                      title={reactors.map((p) => (p === selfPubkey ? "You" : nameOf(p))).join(", ")}
                      className={cn(
                        // Solid chip on a real border — translucent fills read
                        // washed-out on the dark card (mockup .react/.react.on).
                        "text-xs rounded-full border px-2 py-0.5 flex items-center gap-1 transition-colors",
                        myEmojis.has(emoji)
                          ? "border-circle-you bg-circle-you-soft text-circle-you"
                          : "border-border bg-card text-muted-foreground hover:border-muted-foreground/60",
                      )}
                    >
                      <span>{emoji}</span>
                      <span className="tabular-nums font-medium">{reactors.length}</span>
                    </button>
                  ))}
                </div>
              )}
              {isSelf && m.deliveryStatus && m.deliveryStatus !== "delivered" && (
                <span
                  className={cn(
                    "inline-block mt-1 text-[10px] font-medium rounded px-1.5 py-0.5",
                    m.deliveryStatus === "failed"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {m.deliveryStatus === "failed"
                    ? "not delivered"
                    : m.deliveryStatus === "partial"
                      ? "partly delivered"
                      : "sending…"}
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
