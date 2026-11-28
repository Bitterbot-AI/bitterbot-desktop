import { Markdown } from "../ui/markdown";

interface StreamingBubbleProps {
  text: string;
}

/**
 * A reply as it arrives, set where the finished reply will sit. One quiet dot
 * says work is in progress; the status is announced once, not per token.
 */
export function StreamingBubble({ text }: StreamingBubbleProps) {
  return (
    <div data-message-role="assistant" data-streaming="true">
      {text && (
        <div className="prose chat-markdown max-w-none text-ink">
          <Markdown>{text}</Markdown>
        </div>
      )}
      <div className="flex h-8 items-center" role="status">
        <span className="size-2 rounded-full bg-ink-muted motion-safe:animate-pulse" />
        <span className="sr-only">Responding</span>
      </div>
    </div>
  );
}
