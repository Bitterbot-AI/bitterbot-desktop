import { useEffect, useRef } from "react";
import { useChatStore } from "../../stores/chat-store";
import { MessageBubble } from "./MessageBubble";
import { StreamingBubble } from "./StreamingBubble";

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const activeRun = useChatStore((s) => s.activeRun);
  const loading = useChatStore((s) => s.loading);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages or streaming updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, activeRun?.text]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" />
          <span>Loading chat history...</span>
        </div>
      </div>
    );
  }

  if (messages.length === 0 && !activeRun) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-6 max-w-lg px-4">
          <div className="flex justify-center mb-4">
            <img src="/bitterbot_avatar.png" alt="BitterBot" className="w-20 h-20 object-contain" />
          </div>
          <h2 className="text-4xl font-bold bg-gradient-to-r from-white via-purple-200 to-purple-400 bg-clip-text text-transparent">
            How can I help you today?
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Start a conversation with BitterBot — your AI development assistant.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-4 space-y-1 scrollbar-thin scrollbar-thumb-purple-500/20 scrollbar-track-transparent">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {activeRun && <StreamingBubble text={activeRun.text} />}

      <div ref={bottomRef} />
    </div>
  );
}
