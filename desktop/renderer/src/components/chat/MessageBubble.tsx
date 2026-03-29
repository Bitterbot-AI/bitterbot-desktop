import { memo, useCallback } from "react";
import type { ChatMessage, ToolCallItem } from "../../stores/chat-store";
import { useUIStore } from "../../stores/ui-store";
import { BitterBotAvatar } from "./BitterBotAvatar";
import { ArtifactChip } from "./ArtifactChip";
import { Markdown } from "../ui/markdown";
import { cn } from "../../lib/utils";
import {
  Terminal,
  FileCode,
  Search,
  Globe,
  Wrench,
  CheckCircle,
  CheckCircle2,
  AlertTriangle,
  Trophy,
} from "lucide-react";

interface MessageBubbleProps {
  message: ChatMessage;
  onToolCallClick?: (toolCallId: string) => void;
}

const COMPLETE_CHIP_NAMES = new Set(["complete", "task_complete", "task-complete"]);

/** Map tool names to icons (same logic as ToolCallPanel). */
function getToolChipIcon(name: string) {
  const lower = name.toLowerCase();
  if (COMPLETE_CHIP_NAMES.has(lower))
    return Trophy;
  if (lower === "ask" || lower.includes("ask_user") || lower.includes("ask-user"))
    return Wrench;
  if (lower.includes("command") || lower.includes("execute") || lower.includes("shell") || lower.includes("terminal"))
    return Terminal;
  if (lower.includes("file") || lower.includes("write") || lower.includes("read") || lower.includes("edit") || lower.includes("str-replace") || lower.includes("str_replace"))
    return FileCode;
  if (lower.includes("search") || lower.includes("find") || lower.includes("grep"))
    return Search;
  if (lower.includes("browser") || lower.includes("web") || lower.includes("fetch") || lower.includes("screenshot"))
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

export const MessageBubble = memo(function MessageBubble({
  message,
  onToolCallClick,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const setToolPanelOpen = useUIStore((s) => s.setToolPanelOpen);

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
      className={cn(
        "flex gap-3 px-4 py-2 group",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      {/* Avatar */}
      <div className="flex-shrink-0 mt-1">
        {isAssistant ? (
          <BitterBotAvatar size={28} />
        ) : isUser ? (
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium"
            style={{
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            }}
          >
            <span className="text-white">U</span>
          </div>
        ) : (
          <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs text-muted-foreground">
            S
          </div>
        )}
      </div>

      {/* Content */}
      <div
        className={cn("max-w-[80%] min-w-0", isUser ? "items-end" : "items-start")}
      >
        {/* Thinking block (collapsible) */}
        {message.thinking && (
          <details className="mb-2">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
              Reasoning
            </summary>
            <div className="mt-1 text-xs text-muted-foreground/80 italic pl-3 border-l-2 border-purple-500/20">
              {message.thinking}
            </div>
          </details>
        )}

        {/* Images */}
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={
                  img.type === "url"
                    ? img.data
                    : `data:${img.mimeType ?? "image/png"};base64,${img.data}`
                }
                alt="attachment"
                className="max-w-[300px] max-h-[200px] rounded-lg border border-border/30 object-contain"
              />
            ))}
          </div>
        )}

        {/* Message content */}
        {message.content && (
          <div
            className={cn(
              "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
              isUser
                ? "bg-gradient-to-br from-[#8b5cf6] to-[#7c3aed] text-white"
                : "bg-card/80 border border-border/30 backdrop-blur-sm text-foreground",
            )}
            data-message-role={message.role}
          >
            {isUser ? (
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            ) : (
              <div className="prose prose-sm max-w-none chat-markdown">
                <Markdown>{message.content}</Markdown>
              </div>
            )}
          </div>
        )}

        {/* Inline tool call chips */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
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
              const isComplete = COMPLETE_CHIP_NAMES.has(tc.name.toLowerCase());
              return (
                <button
                  key={tc.id ?? i}
                  onClick={() => handleChipClick(tc.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium",
                    "border transition-all cursor-pointer hover:scale-[1.02]",
                    isError
                      ? "bg-red-500/5 border-red-500/20 text-red-400 hover:bg-red-500/10"
                      : isComplete
                        ? "bg-gradient-to-r from-emerald-500/10 to-emerald-600/5 border-emerald-500/30 text-emerald-400 hover:from-emerald-500/15 hover:to-emerald-600/10"
                        : "bg-purple-500/5 border-purple-500/20 text-purple-400 hover:bg-purple-500/10",
                  )}
                >
                  <Icon className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate max-w-[180px]">{tc.name}</span>
                  {primaryParam && (
                    <>
                      <span className="text-muted-foreground/40">|</span>
                      <span className="text-muted-foreground/70 truncate max-w-[150px] font-normal">
                        {primaryParam}
                      </span>
                    </>
                  )}
                  {isError ? (
                    <AlertTriangle className="w-2.5 h-2.5 text-red-400 flex-shrink-0" />
                  ) : isComplete ? (
                    <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400 flex-shrink-0" />
                  ) : tc.result !== undefined ? (
                    <CheckCircle className="w-2.5 h-2.5 text-emerald-400 flex-shrink-0" />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        {/* Timestamp */}
        <div
          className={cn(
            "text-[10px] text-muted-foreground/50 mt-1 opacity-0 group-hover:opacity-100 transition-opacity",
            isUser ? "text-right" : "text-left",
          )}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
});

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
