import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChatStore } from "../../stores/chat-store";
import { useDraftStore } from "../../stores/draft-store";
import { MessageBubble } from "./MessageBubble";
import { StreamingBubble } from "./StreamingBubble";

/** New output is followed only while the reader is this close to the end. */
export const FOLLOW_THRESHOLD_PX = 48;

export function isNearBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

/**
 * The transcript: an 800px reading column that follows a streaming reply
 * while the reader is at the end, leaves them alone once they scroll up, and
 * comes back to where they were when they return to the conversation.
 */
export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const activeRun = useChatStore((s) => s.activeRun);
  const loading = useChatStore((s) => s.loading);
  const sessionKey = useChatStore((s) => s.sessionKey);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef<number | null>(null);
  const restoredFor = useRef<string | null>(null);
  /** Messages already accounted for, so loaded history is not mistaken for a send. */
  const seenCount = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const toBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    following.current = true;
    setShowJump(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    lastTop.current = el.scrollTop;
    following.current = isNearBottom(el);
    setShowJump(!following.current);
  }, []);

  // Leaving a conversation (or the chat view) records where the reader was.
  useEffect(() => {
    lastTop.current = null;
    return () => {
      if (lastTop.current !== null) {
        useDraftStore.getState().setScroll(sessionKey, lastTop.current);
      }
    };
  }, [sessionKey]);

  const ready = !loading && messages.length > 0;

  // First paint of a conversation: back to the saved position, else the end.
  useLayoutEffect(() => {
    if (!ready || restoredFor.current === sessionKey) return;
    restoredFor.current = sessionKey;
    seenCount.current = messages.length;
    const el = scrollerRef.current;
    if (!el) return;
    const saved = useDraftStore.getState().scroll[sessionKey];
    if (saved === undefined) {
      toBottom();
      return;
    }
    el.scrollTop = saved;
    following.current = isNearBottom(el);
    setShowJump(!following.current);
  }, [ready, sessionKey, toBottom, messages.length]);

  // A message the person just sent always comes into view; anything else
  // only moves the transcript while they are already at the end.
  const lastRole = messages[messages.length - 1]?.role;
  useLayoutEffect(() => {
    const grew = messages.length > seenCount.current;
    seenCount.current = messages.length;
    if (restoredFor.current !== sessionKey) return;
    if (following.current || (grew && lastRole === "user")) toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on new content only
  }, [messages.length, activeRun?.text]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ink-muted" role="status">
        Loading conversation…
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-testid="transcript"
        className="flex-1 overflow-y-auto px-3 [scrollbar-gutter:stable_both-edges] md:px-5"
      >
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-7 pb-8 pt-4">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {activeRun && <StreamingBubble text={activeRun.text} />}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-sm text-ink shadow-menu transition-colors hover:bg-hover"
        >
          Jump to latest
          <ArrowDown className="size-4" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
