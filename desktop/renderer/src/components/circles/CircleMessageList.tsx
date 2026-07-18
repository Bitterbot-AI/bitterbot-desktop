import { Pin, Reply, ShieldCheck, SmilePlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CircleMember, CircleMessage, MessageAnnotations } from "../../stores/circles-store";
import { unwrapForDisplay } from "../../lib/external-content-display";
import { cn } from "../../lib/utils";

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

interface Props {
  messages: CircleMessage[];
  members: CircleMember[];
  selfPubkey: string | undefined;
  onReply: (m: CircleMessage) => void;
  /** Phase D: reactions + pins folded from the event log. */
  annotations?: MessageAnnotations;
  /** Toggle ONE emoji in our reaction set on a message. */
  onToggleReaction?: (m: CircleMessage, emoji: string) => void;
  onTogglePin?: (m: CircleMessage, pinned: boolean) => void;
}

export function CircleMessageList({
  messages,
  members,
  selfPubkey,
  onReply,
  annotations,
  onToggleReaction,
  onTogglePin,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.memberPubkey, m.displayName ?? "friend");
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
        const name = isSelf ? "You" : nameOf(m.authorPubkey);
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
                    isPinned ? "text-primary" : "text-muted-foreground",
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
                      myEmojis.has(e) && "bg-primary/15",
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
            <div
              className="w-8 h-8 rounded-lg shrink-0 grid place-items-center text-xs font-bold text-white"
              style={{ background: color }}
            >
              {initials(name)}
            </div>
            <div className="min-w-0 flex-1">
              {m.replyTo && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5 min-w-0">
                  <Reply className="w-3 h-3 shrink-0" />
                  {parent ? (
                    <>
                      <span className="font-medium shrink-0">
                        {parent.direction === "out" || parent.authorPubkey === selfPubkey
                          ? "You"
                          : nameOf(parent.authorPubkey)}
                      </span>
                      <span className="truncate opacity-80">
                        {unwrapForDisplay(parent.content).text}
                      </span>
                    </>
                  ) : (
                    <span>replied to an earlier message</span>
                  )}
                </div>
              )}
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm font-semibold">{name}</span>
                {isSelf && (
                  <span className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-primary/10 text-primary">
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
                  <span title="Pinned for the circle" className="text-primary">
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
              <div className="text-sm whitespace-pre-wrap break-words">{display.text}</div>
              {byEmoji.size > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {[...byEmoji.entries()].map(([emoji, reactors]) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => toggle(emoji)}
                      title={reactors.map((p) => (p === selfPubkey ? "You" : nameOf(p))).join(", ")}
                      className={cn(
                        "text-xs rounded-full border px-1.5 py-0.5 flex items-center gap-1 hover:border-muted-foreground/50",
                        myEmojis.has(emoji)
                          ? "border-primary bg-primary/10"
                          : "border-border bg-muted/40",
                      )}
                    >
                      <span>{emoji}</span>
                      <span className="tabular-nums text-muted-foreground">{reactors.length}</span>
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
