import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import { useChatStore, nextMsgId } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useProjectsStore } from "../../stores/projects-store";

export function ChatInput() {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionKey = useChatStore((s) => s.sessionKey);
  const activeRun = useChatStore((s) => s.activeRun);
  const addMessage = useChatStore((s) => s.addMessage);
  const startRun = useChatStore((s) => s.startRun);
  const request = useGatewayStore((s) => s.request);
  const status = useGatewayStore((s) => s.status);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);

  const isConnected = status === "connected";
  const isStreaming = activeRun !== null;

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !isConnected) return;

    // Add user message immediately
    addMessage({
      id: nextMsgId(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    });

    setText("");
    setSending(true);

    // Auto-resize textarea back to initial
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const idempotencyKey = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    startRun(idempotencyKey);

    try {
      await request("chat.send", {
        sessionKey,
        message: trimmed,
        idempotencyKey,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      });
    } catch (err) {
      console.error("[chat] send failed:", err);
    } finally {
      setSending(false);
    }
  }, [text, sending, isConnected, sessionKey, addMessage, startRun, request, activeProjectId]);

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
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming) return;
        handleSend();
      }
    },
    [handleSend, isStreaming],
  );

  // Auto-resize textarea
  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className={cn(
          "relative flex items-end gap-2 rounded-xl border transition-all",
          "bg-[rgba(139,92,246,0.05)] border-[rgba(139,92,246,0.2)]",
          "backdrop-blur-xl",
          "shadow-[0_8px_32px_rgba(139,92,246,0.1),inset_0_1px_0_rgba(255,255,255,0.1)]",
          "focus-within:border-[#a855f7] focus-within:shadow-[0_8px_32px_rgba(139,92,246,0.2)]",
        )}
        data-slot="chat-input-wrapper"
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? "Message BitterBot..." : "Connecting to gateway..."}
          disabled={!isConnected}
          rows={1}
          className={cn(
            "flex-1 resize-none bg-transparent py-3 px-4 text-sm",
            "placeholder:text-muted-foreground/50",
            "focus:outline-none",
            "min-h-[44px] max-h-[200px]",
            "disabled:opacity-50",
          )}
        />

        {/* Send / Stop button */}
        <div className="flex-shrink-0 p-2">
          {isStreaming ? (
            <button
              onClick={handleAbort}
              className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center",
                "bg-red-500/80 hover:bg-red-500 text-white",
                "transition-all",
              )}
              title="Stop generating"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!text.trim() || !isConnected || sending}
              className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center",
                "bg-gradient-to-br from-[#a855f7] to-[#ec4899] text-white",
                "hover:shadow-[0_4px_15px_rgba(168,85,247,0.4)] hover:scale-105",
                "active:scale-95",
                "transition-all",
                "disabled:opacity-30 disabled:hover:scale-100 disabled:hover:shadow-none",
              )}
              title="Send message"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground/40 text-center mt-2">
        Press Enter to send, Shift+Enter for newline
      </p>
    </div>
  );
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22L11 13L2 9L22 2Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}
