import { useEffect, useMemo, useRef } from "react";
import type { CircleMember, CircleMessage } from "../../stores/circles-store";
import { cn } from "../../lib/utils";

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
}

export function CircleMessageList({ messages, members, selfPubkey }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.memberPubkey, m.displayName ?? "friend");
    return (pubkey: string) => map.get(pubkey) ?? "friend";
  }, [members]);

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
        return (
          <div key={m.messageId} className="flex gap-3">
            <div
              className="w-8 h-8 rounded-lg shrink-0 grid place-items-center text-xs font-bold text-white"
              style={{ background: color }}
            >
              {initials(name)}
            </div>
            <div className="min-w-0 flex-1">
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
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
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
