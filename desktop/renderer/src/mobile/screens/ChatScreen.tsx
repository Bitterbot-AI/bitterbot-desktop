import { ArrowDown, Sparkles } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BitterBotAvatar } from "../../components/chat/BitterBotAvatar";
import { cn } from "../../lib/utils";
import type { ChatMessage } from "../../stores/chat-store";
import { AVATAR_SRC } from "../components/Chrome";
import { Composer } from "../components/Composer";
import { Markdown } from "../components/Markdown";
import { useMobile } from "../store";

const STARTERS = [
  "What did you dream about last night?",
  "What's on my plate today?",
  "Summarize what we worked on yesterday",
];

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="m-fade-in flex justify-end pl-12">
      <div className="max-w-full rounded-[1.25rem] rounded-br-md bg-[var(--m-user-bubble)] px-4 py-2.5 text-base">
        {message.images?.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.images.map((img, i) => (
              <img
                key={i}
                alt="Attachment"
                src={
                  img.type === "base64"
                    ? `data:${img.mimeType ?? "image/jpeg"};base64,${img.data}`
                    : undefined
                }
                className="max-h-48 rounded-xl object-cover"
              />
            ))}
          </div>
        ) : null}
        {message.content && (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
        )}
      </div>
    </div>
  );
}

function AssistantBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="m-fade-in flex gap-3 pr-2">
      <div className="pt-0.5">
        <BitterBotAvatar size={26} src={AVATAR_SRC} isThinking={streaming} />
      </div>
      <div className="min-w-0 flex-1">
        <Markdown streaming={streaming}>{text}</Markdown>
      </div>
    </div>
  );
}

function SystemNote({ text }: { text: string }) {
  return (
    <div className="m-fade-in mx-auto max-w-[85%] rounded-xl bg-[var(--m-surface)] px-3 py-2 text-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}

function Thinking({ activity }: { activity?: string }) {
  return (
    <div className="m-fade-in flex items-center gap-3">
      <BitterBotAvatar size={26} src={AVATAR_SRC} isThinking />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="m-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        {activity ? <span className="truncate">Using {activity.replaceAll("_", " ")}</span> : null}
      </div>
    </div>
  );
}

function Empty({ onPick }: { onPick: (text: string) => void }) {
  const agentName = useMobile((s) => s.status.agentName);
  return (
    <div className="m-fade-in flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="relative mb-5">
        <BitterBotAvatar size={72} src={AVATAR_SRC} isThinking />
      </div>
      <h2 className="text-lg font-semibold">What's on your mind?</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {agentName && agentName !== "Assistant" ? agentName : "Bitterbot"} remembers what you talked
        about, on every device.
      </p>
      <div className="mt-6 flex w-full flex-col gap-2">
        {STARTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="m-press m-card m-touch flex items-center gap-2.5 px-4 text-left text-sm"
          >
            <Sparkles className="size-4 shrink-0 text-primary" />
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatScreen() {
  const messages = useMobile((s) => s.messages);
  const run = useMobile((s) => s.run);
  const loading = useMobile((s) => s.historyLoading);
  const send = useMobile((s) => s.send);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Follow the stream only while the owner is at the bottom; reading back stays put.
  useLayoutEffect(() => {
    if (pinned) scrollToBottom();
  }, [messages, run?.text, pinned, scrollToBottom]);

  useEffect(() => {
    // Keyboard opening shrinks the viewport: keep the latest message in view.
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (pinned) scrollToBottom();
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, [pinned, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const visible = messages.filter((m) => m.role !== "tool" && (m.content || m.images?.length));
  const empty = !loading && visible.length === 0 && !run;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="mobile-main relative">
        {empty ? (
          <Empty onPick={(t) => void send(t)} />
        ) : (
          <div className="flex flex-col gap-5 px-[var(--m-gutter)] py-5">
            {loading && visible.length === 0 ? (
              <div className="flex justify-center py-10">
                <span className="m-dots" aria-label="Loading">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : null}
            {visible.map((m) =>
              m.role === "user" ? (
                <UserBubble key={m.id} message={m} />
              ) : m.role === "system" ? (
                <SystemNote key={m.id} text={m.content} />
              ) : (
                <AssistantBlock key={m.id} text={m.content} />
              ),
            )}
            {run ? (
              run.text ? (
                <AssistantBlock text={run.text} streaming />
              ) : (
                <Thinking activity={run.activity} />
              )
            ) : null}
          </div>
        )}
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={() => {
            setPinned(true);
            scrollToBottom(true);
          }}
          className={cn(
            "m-press sticky bottom-3 left-full mr-3 flex size-10 items-center justify-center rounded-full border border-[var(--m-hairline)] bg-background/95 text-foreground shadow-lg transition-opacity",
            pinned ? "pointer-events-none opacity-0" : "opacity-100",
          )}
        >
          <ArrowDown className="size-4" />
        </button>
      </div>
      <Composer />
    </div>
  );
}
