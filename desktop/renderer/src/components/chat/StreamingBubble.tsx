import { Markdown } from "../ui/markdown";
import { BitterBotAvatar } from "./BitterBotAvatar";

interface StreamingBubbleProps {
  text: string;
}

export function StreamingBubble({ text }: StreamingBubbleProps) {
  return (
    <div className="flex gap-3 px-4 py-2">
      <div className="flex-shrink-0 mt-1">
        <BitterBotAvatar size={28} isThinking={!text} />
      </div>
      <div className="max-w-[80%] min-w-0">
        <div className="rounded-2xl px-4 py-2.5 text-sm leading-relaxed bg-card/80 border border-border/30 backdrop-blur-sm text-foreground">
          {text ? (
            <div className="prose prose-sm max-w-none chat-markdown">
              <Markdown>{text}</Markdown>
            </div>
          ) : (
            <div className="flex items-center gap-1 py-1">
              <span
                className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
