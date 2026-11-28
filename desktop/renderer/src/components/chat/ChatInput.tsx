import { ArrowUp, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { sendChatText } from "../../lib/chat-send";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";
import { useDraftStore } from "../../stores/draft-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { ModelPicker } from "./ModelPicker";
import { VoiceButton } from "./VoiceButton";

/** Six lines of 16/24 text; past that the draft scrolls inside the composer. */
const MAX_TEXT_HEIGHT = 144;

/**
 * The composer: the draft on top, and under it the model, voice and the
 * round Send control, which becomes Stop while a reply is streaming. Each
 * conversation keeps its own draft.
 */
export function ChatInput() {
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionKey = useChatStore((s) => s.sessionKey);
  const activeRun = useChatStore((s) => s.activeRun);
  const text = useDraftStore((s) => s.drafts[sessionKey] ?? "");
  const setDraft = useDraftStore((s) => s.setDraft);
  const request = useGatewayStore((s) => s.request);
  const status = useGatewayStore((s) => s.status);

  const isConnected = status === "connected";
  const isStreaming = activeRun !== null;
  const canSend = text.trim().length > 0 && isConnected && !sending;

  // Fit the draft, including the one restored when the conversation changes.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXT_HEIGHT)}px`;
  }, [text, sessionKey]);

  // Opening a conversation puts the cursor in its draft.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [sessionKey]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !isConnected) return;
    setDraft(sessionKey, "");
    setSending(true);
    try {
      await sendChatText(trimmed);
    } catch (err) {
      console.error("[chat] send failed:", err);
    } finally {
      setSending(false);
    }
  }, [text, sending, isConnected, sessionKey, setDraft]);

  const handleAbort = useCallback(async () => {
    if (!activeRun) return;
    try {
      await request("chat.abort", {
        sessionKey,
        runId: activeRun.runId,
      });
    } catch (err) {
      console.error("[chat] abort failed:", err);
    }
  }, [activeRun, sessionKey, request]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      // Enter that confirms an input-method candidate is not a send.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (isStreaming) return;
      void handleSend();
    },
    [handleSend, isStreaming],
  );

  return (
    <div className="shrink-0 px-3 pb-3 md:px-5 md:pb-5">
      <div
        className="mx-auto w-full max-w-[800px] rounded-composer border border-line bg-raised shadow-composer transition-colors focus-within:border-control"
        data-slot="chat-input-wrapper"
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setDraft(sessionKey, e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Bitterbot"
          aria-label="Message Bitterbot"
          rows={1}
          className="block max-h-36 w-full resize-none bg-transparent px-4 pt-4 text-base text-ink placeholder:text-ink-muted focus:outline-none"
        />

        <div className="flex items-center gap-1 px-2 pb-2 pt-2">
          {/* The "+" menu takes this side once attachments ship. */}
          <div className="flex-1" />
          <ModelPicker />
          <VoiceButton disabled={!isConnected} />
          {isStreaming ? (
            <button
              type="button"
              onClick={() => void handleAbort()}
              aria-label="Stop"
              title="Stop"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-button text-on-button transition-opacity hover:opacity-85"
            >
              <Square className="size-3.5" fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              aria-label="Send"
              title={isConnected ? "Send" : "Not connected to the gateway"}
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-full transition-colors",
                canSend ? "bg-button text-on-button hover:opacity-85" : "bg-subtle text-ink-muted",
              )}
            >
              <ArrowUp className="size-[18px]" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
