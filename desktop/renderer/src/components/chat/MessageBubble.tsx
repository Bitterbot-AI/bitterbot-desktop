import {
  AlertTriangle,
  Check,
  Copy,
  FileCode,
  Globe,
  Info,
  KeyRound,
  Search,
  Terminal,
  Trophy,
  Wrench,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatCost, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import type { ChatMessage, ToolCallItem } from "../../stores/chat-store";
import { useUIStore } from "../../stores/ui-store";
import { Markdown } from "../ui/markdown";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ArtifactChip } from "./ArtifactChip";

interface MessageBubbleProps {
  message: ChatMessage;
  onToolCallClick?: (toolCallId: string) => void;
}

const COMPLETE_CHIP_NAMES = new Set(["complete", "task_complete", "task-complete"]);

/**
 * The gateway's missing-credential errors all carry this prefix (model-auth
 * keeps it stable for machine matching). When an assistant turn fails with
 * it, the bubble grows a Models & Keys deep link so a fresh install's very
 * first message ends at the fix, not at an error string.
 */
export function isNoApiKeyError(content: string): boolean {
  return content.includes("No API key found for provider");
}

/**
 * May this image URL be rendered inline? Only loopback and data URLs, which
 * are the two sources the CSP still permits and the two that cannot beacon
 * the viewer's IP to a third party. Everything else (any remote host, and
 * anything unparseable) renders as a click-to-open link instead. Parsed, not
 * string-matched: `https://evil.example/?x=http://localhost` must not pass.
 */
export function isLocalImageUrl(raw: string): boolean {
  if (raw.startsWith("data:")) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Map tool names to icons (same logic as ToolCallPanel). */
function getToolChipIcon(name: string) {
  const lower = name.toLowerCase();
  if (COMPLETE_CHIP_NAMES.has(lower)) return Trophy;
  if (lower === "ask" || lower.includes("ask_user") || lower.includes("ask-user")) return Wrench;
  if (
    lower.includes("command") ||
    lower.includes("execute") ||
    lower.includes("shell") ||
    lower.includes("terminal")
  )
    return Terminal;
  if (
    lower.includes("file") ||
    lower.includes("write") ||
    lower.includes("read") ||
    lower.includes("edit") ||
    lower.includes("str-replace") ||
    lower.includes("str_replace")
  )
    return FileCode;
  if (lower.includes("search") || lower.includes("find") || lower.includes("grep")) return Search;
  if (
    lower.includes("browser") ||
    lower.includes("web") ||
    lower.includes("fetch") ||
    lower.includes("screenshot")
  )
    return Globe;
  return Wrench;
}

/** Extract the primary/most informative parameter from a tool call for display. */
function extractPrimaryParam(tc: ToolCallItem): string {
  if (!tc.args || typeof tc.args !== "object") return "";
  const args = tc.args as Record<string, unknown>;

  // Command tools: show command
  if (typeof args.command === "string") return truncateParam(args.command, 50);
  if (typeof args.cmd === "string") return truncateParam(args.cmd, 50);

  // File tools: show path
  if (typeof args.file_path === "string") return truncateParam(args.file_path, 50);
  if (typeof args.path === "string") return truncateParam(args.path, 50);
  if (typeof args.filePath === "string") return truncateParam(args.filePath, 50);

  // Search tools: show query
  if (typeof args.query === "string") return truncateParam(args.query, 50);
  if (typeof args.search_query === "string") return truncateParam(args.search_query, 50);

  // Browser: show url
  if (typeof args.url === "string") return truncateParam(args.url, 50);

  // Fallback: first string argument
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length > 0) {
      return truncateParam(val, 40);
    }
  }
  return "";
}

function truncateParam(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

const ACTION_BUTTON =
  "grid size-8 place-items-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink";

/**
 * One turn. The person's message is a small neutral bubble on the right; the
 * reply is set straight on the canvas like a document, with Copy and Reply
 * details underneath.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  onToolCallClick,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const setToolPanelOpen = useUIStore((s) => s.setToolPanelOpen);
  const setActiveTab = useUIStore((s) => s.setActiveTab);

  const handleChipClick = useCallback(
    (toolCallId?: string) => {
      setToolPanelOpen(true);
      if (toolCallId && onToolCallClick) {
        onToolCallClick(toolCallId);
      }
    },
    [setToolPanelOpen, onToolCallClick],
  );

  return (
    <div
      className={cn("group flex min-w-0 flex-col", isUser ? "items-end" : "items-stretch")}
      data-message-role={message.role}
    >
      {/* Thinking block (collapsible) */}
      {message.thinking && (
        <details className="mb-2">
          <summary className="cursor-pointer text-sm text-ink-secondary transition-colors hover:text-ink">
            Reasoning
          </summary>
          <div className="mt-1 border-l-2 border-line pl-3 text-sm text-ink-secondary">
            {message.thinking}
          </div>
        </details>
      )}

      {/* Images. Inline bytes (base64) and loopback URLs render directly.
          A REMOTE url renders as a click-to-open link, never an <img>: the
          CSP no longer permits remote image hosts, because loading one
          beacons this viewer's IP and read-time to whoever chose the URL.
          Making it a link keeps the content reachable while turning that
          disclosure into an explicit human choice. */}
      {message.images && message.images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {message.images.map((img, i) =>
            img.type === "url" && !isLocalImageUrl(img.data) ? (
              <a
                key={i}
                href={img.data}
                target="_blank"
                rel="noreferrer noopener"
                title={img.data}
                className="max-w-[300px] truncate rounded-md border border-line px-2.5 py-1.5 text-sm text-link hover:underline"
              >
                Remote image: open in browser
              </a>
            ) : (
              <img
                key={i}
                src={
                  img.type === "url"
                    ? img.data
                    : `data:${img.mimeType ?? "image/png"};base64,${img.data}`
                }
                alt="attachment"
                className="max-h-[200px] max-w-[300px] rounded-lg border border-line object-contain"
              />
            ),
          )}
        </div>
      )}

      {/* Message content */}
      {message.content &&
        (isUser ? (
          <p className="max-w-[76%] whitespace-pre-wrap break-words rounded-2xl bg-subtle px-4 py-3 text-base text-ink">
            {message.content}
          </p>
        ) : (
          <div
            className={cn(
              "prose chat-markdown max-w-none",
              isAssistant ? "text-ink" : "text-ink-secondary",
            )}
          >
            <Markdown>{message.content}</Markdown>
          </div>
        ))}

      {isAssistant && isNoApiKeyError(message.content) && (
        <button
          type="button"
          onClick={() => setActiveTab("models")}
          className="mt-3 inline-flex h-9 items-center gap-2 self-start rounded-md border border-control px-3 text-sm font-medium text-ink transition-colors hover:bg-hover"
        >
          <KeyRound className="size-4" strokeWidth={1.75} />
          Open Models &amp; Keys
        </button>
      )}

      {/* What the reply did: one quiet chip per tool call. */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {message.toolCalls.map((tc, i) => {
            // Render artifact chips for create_artifact tool calls
            const isArtifactTool = tc.name === "create_artifact" || tc.name === "create-artifact";
            if (isArtifactTool) {
              const args = tc.args as Record<string, unknown> | undefined;
              const identifier = typeof args?.identifier === "string" ? args.identifier : "";
              if (identifier) {
                return <ArtifactChip key={tc.id ?? i} artifactId={identifier} />;
              }
            }

            const Icon = getToolChipIcon(tc.name);
            const primaryParam = extractPrimaryParam(tc);
            const isError = tc.isSuccess === false;
            return (
              <button
                key={tc.id ?? i}
                type="button"
                onClick={() => handleChipClick(tc.id)}
                className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line px-2 text-xs text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
              >
                <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="max-w-[180px] truncate font-medium">{tc.name}</span>
                {primaryParam && (
                  <span className="max-w-[180px] truncate font-mono text-ink-muted">
                    {primaryParam}
                  </span>
                )}
                {isError ? (
                  <AlertTriangle className="size-3.5 shrink-0 text-danger" strokeWidth={1.75} />
                ) : tc.result !== undefined ? (
                  <Check className="size-3.5 shrink-0 text-success" strokeWidth={1.75} />
                ) : null}
                {isError && <span className="sr-only">failed</span>}
              </button>
            );
          })}
        </div>
      )}

      {isAssistant && message.content && <ReplyActions message={message} />}
    </div>
  );
});

/**
 * Copy and Reply details under a finished reply. Shown on hover or keyboard
 * focus, and always on a touch screen where there is no hover.
 */
function ReplyActions({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the text is still selectable.
    }
  };

  const usage = message.usage;
  return (
    <div className="mt-1 flex h-8 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
        className={ACTION_BUTTON}
      >
        {copied ? (
          <Check className="size-4" strokeWidth={1.75} />
        ) : (
          <Copy className="size-4" strokeWidth={1.75} />
        )}
      </button>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Reply details"
            title="Reply details"
            className={ACTION_BUTTON}
          >
            <Info className="size-4" strokeWidth={1.75} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-3 text-sm">
          <dl className="space-y-2 tabular-nums">
            <Detail label="Sent">{formatTime(message.timestamp) || "Unavailable"}</Detail>
            <Detail label="Prompt tokens">
              {usage && usage.total > 0 ? formatTokens(usage.input) : "Unavailable"}
            </Detail>
            <Detail label="Reply tokens">
              {usage && usage.total > 0 ? formatTokens(usage.output) : "Unavailable"}
            </Detail>
            <Detail label="Cost">
              {typeof usage?.cost === "number" ? formatCost(usage.cost) : "Unavailable"}
            </Detail>
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
