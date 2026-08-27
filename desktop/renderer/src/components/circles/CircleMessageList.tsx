import { ArrowDown, Pin, Reply, ShieldCheck, SmilePlus, StickyNote, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { unwrapForDisplay } from "../../lib/external-content-display";
import { cn } from "../../lib/utils";
import {
  HISTORY_PAGE,
  memberName,
  useCirclesStore,
  type CircleMember,
  type CircleMessage,
  type MessageAnnotations,
} from "../../stores/circles-store";
import { initialsFor as initials, memberColor } from "./circle-identity";
import { CircleMarkdown } from "./CircleMarkdown";
import { buildTimeline, fmtFullDate, fmtTime } from "./timeline";

// Phase D reactions: a small fixed palette keeps the picker one tap deep.
const REACTION_PALETTE = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

// PLAN-36 Phase A + Phase A' (readable timeline): the circle conversation
// stream. Rows group Slack-style inside a 10-minute same-author window, day
// dividers orient history, the frozen "New" line marks what arrived since the
// circle was last open, and scroll is ANCHORED — it follows the conversation
// only when you're already at the bottom; otherwise a jump pill counts what
// you're missing. Bodies render restricted markdown (CircleMarkdown).

// A pasted/delivered invite code in a message body (bbc1.<base64url>).
// Detection only — tapping Join runs the full signature-checked join
// ceremony server-side; the code is data until the human consents.
const INVITE_CODE_RE = /\bbbc1\.[A-Za-z0-9_-]{20,}/;

/** How close to the bottom still counts as "at the bottom" (px). */
const AT_BOTTOM_SLACK_PX = 48;

interface Props {
  /** undefined = still loading (skeleton); [] = truly empty. */
  messages: CircleMessage[] | undefined;
  members: CircleMember[];
  selfPubkey: string | undefined;
  /** The frozen read marker anchoring the "New" divider (0 = never read). */
  readFrontier?: number;
  /** Fetch the next older history page; resolves to how many were added. */
  onLoadOlder?: () => Promise<number>;
  /** False once the top of history is proven — hides the load affordance. */
  hasMoreHistory?: boolean;
  /** Phase D: a pin tap jumps to (and briefly highlights) this message. */
  focusEnvelopeId?: string | null;
  /** Called once the jump has been handled (found or not). */
  onFocusConsumed?: () => void;
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

function TimelineSkeleton() {
  // Loading is NOT "no messages yet" — a circle with history must never flash
  // the empty-state copy while the RPC is in flight.
  const widths = ["w-3/5", "w-2/5", "w-4/5", "w-1/3", "w-1/2", "w-2/3"];
  return (
    <div className="flex-1 overflow-hidden px-4 py-3 space-y-4" aria-label="Loading messages">
      {widths.map((w, i) => (
        <div key={i} className="flex gap-3 animate-pulse">
          <div className="w-8 h-8 rounded-lg shrink-0 bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
            <div className="h-3 w-24 rounded bg-muted" />
            <div className={cn("h-3 rounded bg-muted/70", w)} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CircleMessageList({
  messages,
  members,
  selfPubkey,
  readFrontier,
  onLoadOlder,
  hasMoreHistory,
  focusEnvelopeId,
  onFocusConsumed,
  onReply,
  annotations,
  onToggleReaction,
  onJoinInvite,
  onTogglePin,
  onDelete,
  onAddToCanvas,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pendingNew, setPendingNew] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Anchored scroll state lives in refs — scrolling must never re-render.
  const atBottomRef = useRef(true);
  const firstIdRef = useRef<string | undefined>(undefined);
  const lastIdRef = useRef<string | undefined>(undefined);
  const countRef = useRef(0);
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  // Entrance animation (the plan's deferred Buzz arrival treatment): only
  // messages that ARRIVE animate — never the initial load and never
  // history-page prepends. The diffing lives in the layout effect (render
  // stays pure); arrivedIds is state so the class is committed before paint
  // and stays on the row until it pages out — the one-shot animation is
  // never cut mid-flight.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const prevFirstCreatedAtRef = useRef<number | undefined>(undefined);
  const [arrivedIds, setArrivedIds] = useState<ReadonlySet<string>>(new Set());

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.memberPubkey, memberName(m));
    return (pubkey: string) => map.get(pubkey) ?? "friend";
  }, [members]);

  // Resolve a reply's parent locally by its shared envelope id (A3).
  const byEnvelope = useMemo(() => {
    const map = new Map<string, CircleMessage>();
    for (const m of messages ?? []) if (m.envelopeId) map.set(m.envelopeId, m);
    return map;
  }, [messages]);

  const timeline = useMemo(
    () => buildTimeline(messages ?? [], readFrontier),
    [messages, readFrontier],
  );

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setPendingNew(0);
  };

  // The anchor logic. Runs after every commit that changed the message run:
  //  - a history prepend (detected by the FIRST id changing while the anchor
  //    is armed — never by the mere presence of the armed ref, so a poll
  //    append landing while the page RPC is in flight can't consume it and
  //    yank the reader) restores the exact prior viewport;
  //  - first load / own send / already-at-bottom sticks to the bottom;
  //  - anything else that grew the run — tail appends AND out-of-order
  //    mid-inserts (routine in P2P delivery) — counts up the jump pill.
  useLayoutEffect(() => {
    if (messages === undefined) return;
    const el = scrollRef.current;
    const firstId = messages[0]?.messageId;
    const lastId = messages[messages.length - 1]?.messageId;
    const grewBy = messages.length - countRef.current;
    const firstLoad = lastIdRef.current === undefined && countRef.current === 0;
    const prepended =
      prependRef.current !== null && !firstLoad && firstId !== firstIdRef.current && grewBy > 0;

    // Arrival-animation bookkeeping runs even with NO scroller mounted — the
    // first message into an open empty circle must animate too (review #4).
    // Prepended history (rows at or older than the previous window head)
    // never animates (#5); arrivedIds is pruned to the live list, never
    // wholesale-cleared (#7).
    const prevFloor = prevFirstCreatedAtRef.current ?? Number.MAX_SAFE_INTEGER;
    const fresh = seededRef.current
      ? messages
          .filter((m) => !knownIdsRef.current.has(m.messageId) && !m.deleted)
          .filter((m) => !(prepended && m.createdAt <= prevFloor))
          .map((m) => m.messageId)
      : [];
    knownIdsRef.current = new Set(messages.map((m) => m.messageId));
    prevFirstCreatedAtRef.current = messages[0]?.createdAt;
    seededRef.current = true;
    if (fresh.length > 0) {
      setArrivedIds((prev) => {
        const live = knownIdsRef.current;
        const next = new Set([...prev].filter((id) => live.has(id)));
        for (const id of fresh) next.add(id);
        return next;
      });
    }

    if (!el) return;

    if (prepended && prependRef.current) {
      el.scrollTop = el.scrollHeight - prependRef.current.height + prependRef.current.top;
      prependRef.current = null;
    } else if (grewBy > 0 || lastId !== lastIdRef.current) {
      // Own sends scroll even when a slightly-later peer message merged in
      // the same window — any own message among the new tail counts.
      const prevIdx = messages.findIndex((m) => m.messageId === lastIdRef.current);
      const appendedTail = prevIdx >= 0 ? messages.slice(prevIdx + 1) : [];
      const ownSend = appendedTail.some(
        (m) => (m.direction === "out" || m.authorPubkey === selfPubkey) && !m.deleted,
      );
      if (firstLoad || ownSend || atBottomRef.current) {
        el.scrollTop = el.scrollHeight;
        atBottomRef.current = true;
        setPendingNew(0);
      } else if (grewBy > 0) {
        setPendingNew((n) => n + grewBy);
      }
    }
    firstIdRef.current = firstId;
    lastIdRef.current = lastId;
    countRef.current = messages.length;
  }, [messages, selfPubkey]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX;
    atBottomRef.current = atBottom;
    if (atBottom) setPendingNew(0);
  };

  // Phase D: a pin tap jumps to its message. If the message is older than the
  // loaded history, say so instead of doing nothing.
  useEffect(() => {
    if (!focusEnvelopeId) return;
    const escaped =
      typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(focusEnvelopeId) : focusEnvelopeId;
    const el = scrollRef.current?.querySelector(`[data-envelope="${escaped}"]`);
    if (el) {
      (el as HTMLElement).scrollIntoView?.({ block: "center" });
      setHighlightId(focusEnvelopeId);
      const t = setTimeout(() => setHighlightId(null), 1800);
      onFocusConsumed?.();
      return () => clearTimeout(t);
    }
    useCirclesStore
      .getState()
      .setNotice(
        "That pinned message is older than the loaded history — use “Load earlier messages” to reach it.",
      );
    onFocusConsumed?.();
  }, [focusEnvelopeId, onFocusConsumed]);

  const loadOlder = async () => {
    const el = scrollRef.current;
    if (!onLoadOlder || loadingOlder || !el) return;
    setLoadingOlder(true);
    prependRef.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      const added = await onLoadOlder();
      if (added === 0) prependRef.current = null;
    } finally {
      setLoadingOlder(false);
    }
  };

  if (messages === undefined) return <TimelineSkeleton />;

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No messages yet. Say hello.
      </div>
    );
  }

  const showLoadOlder =
    !!onLoadOlder && hasMoreHistory !== false && messages.length >= HISTORY_PAGE;

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-3">
        {showLoadOlder && (
          <div className="flex justify-center mb-2">
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              className="text-xs text-muted-foreground hover:text-foreground border rounded-full px-3 py-1 disabled:opacity-50"
            >
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </button>
          </div>
        )}
        {timeline.map((item, idx) => {
          if (item.type === "day") {
            return (
              <div
                key={`day-${item.ts}`}
                className={cn("flex items-center gap-3", idx === 0 ? "mb-3" : "my-3")}
              >
                <div className="h-px flex-1 bg-border" />
                <span className="shrink-0 rounded-full border px-2.5 py-0.5 text-2xs font-medium text-muted-foreground">
                  {item.label}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            );
          }
          if (item.type === "unread") {
            return (
              <div key="unread" className="flex items-center gap-2 my-2" aria-label="New messages">
                <div className="h-px flex-1 bg-circle-you/50" />
                <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-circle-you">
                  New
                </span>
                <div className="h-px flex-1 bg-circle-you/50" />
              </div>
            );
          }

          const m = item.message;
          const isSelf = m.direction === "out" || m.authorPubkey === selfPubkey;
          // Mockup pin 2: agent-written text is attributed to the AGENT, bound
          // to its owner — "Maya's agent", never plain "Maya".
          const isAgent = m.agentAuthored === true;
          const owner = isSelf ? "You" : nameOf(m.authorPubkey);
          const name = isAgent ? (isSelf ? "Your agent" : `${owner}'s agent`) : owner;
          const color = memberColor(m.authorPubkey, isSelf);
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
          // A pinned follow-up keeps its full header — the pin marker lives
          // there and must never be silently dropped by grouping (review #6).
          const continuation = item.isContinuation && !isPinned;
          const toggle = (emoji: string) => {
            if (!onToggleReaction) return;
            setPickerFor(null);
            onToggleReaction(m, emoji);
          };
          if (m.deleted) {
            return (
              <div key={m.messageId} className="flex gap-3 opacity-60 mt-3">
                <div className="w-8 h-8 rounded-lg shrink-0 grid place-items-center text-xs text-muted-foreground border border-border/40">
                  <Trash2 className="w-3.5 h-3.5" aria-label="deleted" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-muted-foreground">
                      {isSelf ? "You" : nameOf(m.authorPubkey)}
                    </span>
                    <span
                      className="text-2xs text-muted-foreground tabular-nums"
                      title={fmtFullDate(m.createdAt)}
                    >
                      {fmtTime(m.createdAt)}
                    </span>
                  </div>
                  <div className="text-sm italic text-muted-foreground">
                    {m.deletedByMe ? "hidden by you" : "message deleted"}
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div
              key={m.messageId}
              data-envelope={m.envelopeId ?? undefined}
              className={cn(
                "group relative flex gap-3 rounded-md transition-colors duration-500",
                continuation ? "mt-0.5" : "mt-3",
                arrivedIds.has(m.messageId) && "motion-enter-conversation",
                !!m.envelopeId && highlightId === m.envelopeId && "bg-circle-you-soft/60",
              )}
            >
              <div className="absolute right-0 top-0 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center rounded-md border bg-background/95 shadow-sm px-0.5">
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
                    className="text-muted-foreground hover:text-danger p-1 rounded"
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
                        "text-base leading-none p-1 rounded hover:bg-muted/90",
                        myEmojis.has(e) && "bg-circle-you-soft",
                      )}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
              {continuation ? (
                // Continuation gutter: avatar-width, hover-revealed timestamp.
                <div className="w-8 shrink-0 flex items-start justify-end pt-1">
                  <span
                    className="text-3xs text-muted-foreground tabular-nums opacity-0 group-hover:opacity-100"
                    title={fmtFullDate(m.createdAt)}
                  >
                    {fmtTime(m.createdAt)}
                  </span>
                </div>
              ) : isAgent ? (
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
                  <div className="flex items-center gap-1.5 text-2xs text-muted-foreground mb-0.5 min-w-0">
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
                {!continuation && (
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-semibold">{name}</span>
                    {isAgent && (
                      <span className="text-badge font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-circle-agent-soft text-circle-agent">
                        agent
                      </span>
                    )}
                    {isSelf && !isAgent && (
                      <span className="text-badge font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-circle-you-soft text-circle-you">
                        you
                      </span>
                    )}
                    {m.kind !== "message" && (
                      <span className="text-badge font-bold uppercase tracking-wide rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                        {m.kind}
                      </span>
                    )}
                    <span
                      className="text-2xs text-muted-foreground tabular-nums"
                      title={fmtFullDate(m.createdAt)}
                    >
                      {fmtTime(m.createdAt)}
                    </span>
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
                )}
                {isAgent ? (
                  // The mockup's .agentmsg treatment: a quiet violet-edged card
                  // so agent words never blend into human conversation.
                  <div className="mt-0.5 rounded-md border border-border border-l-2 border-l-circle-agent bg-card px-2.5 py-1.5 text-sm break-words">
                    <CircleMarkdown text={display.text} />
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
                  <div className="text-sm break-words">
                    <CircleMarkdown text={display.text} />
                  </div>
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
                        title={reactors
                          .map((p) => (p === selfPubkey ? "You" : nameOf(p)))
                          .join(", ")}
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
                      "inline-block mt-1 text-badge font-medium rounded px-1.5 py-0.5",
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
      </div>
      {pendingNew > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 motion-enter-conversation flex items-center gap-1.5 rounded-full border bg-background/95 shadow-sm px-3 py-1 text-xs font-medium text-circle-you hover:bg-circle-you-soft"
        >
          <ArrowDown className="w-3.5 h-3.5" />
          {pendingNew === 1 ? "1 new message" : `${pendingNew} new messages`}
        </button>
      )}
    </div>
  );
}
