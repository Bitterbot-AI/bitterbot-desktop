import {
  X,
  ChevronLeft,
  ChevronRight,
  Terminal,
  FileCode,
  Search,
  Globe,
  Wrench,
  Code,
  ListTree,
  FolderOpen,
  CheckCircle,
  AlertTriangle,
  FileEdit,
} from "lucide-react";
import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { useArtifactStore, type RightPanelMode } from "../../stores/artifact-store";
import { useChatStore, type ActiveToolCall } from "../../stores/chat-store";
import { useCoworkStore } from "../../stores/cowork-store";
import { useUIStore } from "../../stores/ui-store";
import { CoworkPanel } from "../cowork/CoworkPanel";
import { WorkspaceFilesPanel } from "../workspace/WorkspaceFilesPanel";
import { ArtifactPanel } from "./ArtifactPanel";
import {
  extractFilePath,
  parseExitCode,
  getLanguageFromExtension,
} from "./tool-views/tool-view-utils";
import { ToolView } from "./tool-views/ToolViewRegistry";

/** Map tool names to icons + colors */
function getToolMeta(name: string): { icon: typeof Terminal; color: string; gradient: string } {
  const lower = name.toLowerCase();
  if (lower === "complete" || lower.includes("task_complete") || lower.includes("task-complete"))
    return {
      icon: CheckCircle,
      color: "text-emerald-400",
      gradient: "from-emerald-500/20 to-emerald-600/10",
    };
  if (lower === "ask" || lower.includes("ask_user") || lower.includes("ask-user"))
    return { icon: Wrench, color: "text-blue-400", gradient: "from-blue-500/20 to-blue-600/10" };
  if (lower === "plan")
    return {
      icon: ListTree,
      color: "text-indigo-400",
      gradient: "from-indigo-500/20 to-indigo-600/10",
    };
  if (
    lower.includes("command") ||
    lower.includes("execute") ||
    lower.includes("shell") ||
    lower.includes("terminal")
  )
    return {
      icon: Terminal,
      color: "text-purple-400",
      gradient: "from-purple-500/20 to-purple-600/10",
    };
  if (lower.includes("str-replace") || lower.includes("str_replace"))
    return {
      icon: FileEdit,
      color: "text-amber-400",
      gradient: "from-amber-500/20 to-amber-600/10",
    };
  if (
    lower.includes("file") ||
    lower.includes("write") ||
    lower.includes("read") ||
    lower.includes("edit")
  )
    return { icon: FileCode, color: "text-blue-400", gradient: "from-blue-500/20 to-blue-600/10" };
  if (lower.includes("search") || lower.includes("find") || lower.includes("grep"))
    return { icon: Search, color: "text-cyan-400", gradient: "from-cyan-500/20 to-cyan-600/10" };
  if (
    lower.includes("browser") ||
    lower.includes("web") ||
    lower.includes("crawl") ||
    lower.includes("scrape") ||
    lower.includes("fetch") ||
    lower.includes("screenshot")
  )
    return { icon: Globe, color: "text-green-400", gradient: "from-green-500/20 to-green-600/10" };
  return {
    icon: Wrench,
    color: "text-purple-400",
    gradient: "from-purple-500/20 to-purple-600/10",
  };
}

/** Get a user-friendly display name for a tool. */
function getToolDisplayName(name: string): string {
  const DISPLAY_NAMES: Record<string, string> = {
    "execute-command": "Execute Command",
    execute_command: "Execute Command",
    "run-command": "Run Command",
    run_command: "Run Command",
    "read-file": "Read File",
    read_file: "Read File",
    "write-file": "Write File",
    write_file: "Write File",
    "create-file": "Create File",
    create_file: "Create File",
    "edit-file": "Edit File",
    edit_file: "Edit File",
    "str-replace-editor": "Edit File",
    str_replace_editor: "Edit File",
    "delete-file": "Delete File",
    delete_file: "Delete File",
    "list-directory": "List Directory",
    list_directory: "List Directory",
    "browser-action": "Browser Action",
    browser_action: "Browser Action",
    "web-search": "Web Search",
    web_search: "Web Search",
    search: "Search",
    "take-screenshot": "Screenshot",
    take_screenshot: "Screenshot",
    "see-image": "View Image",
    "web-crawl": "Web Crawl",
    web_crawl: "Web Crawl",
    "scrape-webpage": "Scrape Page",
    scrape_webpage: "Scrape Page",
    "terminate-command": "Terminate Command",
    terminate_command: "Terminate Command",
    complete: "Task Complete",
    "task-complete": "Task Complete",
    task_complete: "Task Complete",
    ask: "Ask User",
    "ask-user": "Ask User",
    ask_user: "Ask User",
    plan: "Task Plan",
  };
  return DISPLAY_NAMES[name] ?? name;
}

type NavigationMode = "live" | "manual";

export function ToolCallPanel() {
  const toolCalls = useChatStore((s) => s.toolCalls);
  const setToolPanelOpen = useUIStore((s) => s.setToolPanelOpen);
  const panelMode = useArtifactStore((s) => s.panelMode);
  const setPanelMode = useArtifactStore((s) => s.setPanelMode);
  const hasArtifacts = useArtifactStore((s) => s.artifacts.size > 0);
  const hasTasks = useCoworkStore((s) => s.tasks.size > 0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [navMode, setNavMode] = useState<NavigationMode>("live");
  const prevLengthRef = useRef(0);
  const hasAutoSwitchedToTasks = useRef(false);

  // Auto-follow latest tool call in live mode
  useEffect(() => {
    const hasNew = toolCalls.length > prevLengthRef.current;
    prevLengthRef.current = toolCalls.length;

    if (hasNew && navMode === "live" && toolCalls.length > 0) {
      setCurrentIndex(toolCalls.length - 1);
    }
  }, [toolCalls.length, navMode]);

  // Auto-switch to Tasks tab when tasks first appear (once per session)
  useEffect(() => {
    if (hasTasks && !hasAutoSwitchedToTasks.current && panelMode === "tools") {
      hasAutoSwitchedToTasks.current = true;
      setPanelMode("tasks");
    }
  }, [hasTasks, panelMode, setPanelMode]);

  const displayIndex = toolCalls.length === 0 ? 0 : Math.min(currentIndex, toolCalls.length - 1);
  const currentCall: ActiveToolCall | undefined = toolCalls[displayIndex];

  const completedCount = toolCalls.filter((tc) => tc.status !== "running").length;
  const anyRunning = toolCalls.some((tc) => tc.status === "running");

  const hasPrev = displayIndex > 0;
  const hasNext = displayIndex < toolCalls.length - 1;

  const navigateTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, toolCalls.length - 1));
      setCurrentIndex(clamped);
      if (clamped === toolCalls.length - 1) {
        setNavMode("live");
      } else {
        setNavMode("manual");
      }
    },
    [toolCalls.length],
  );

  const jumpToLive = useCallback(() => {
    setNavMode("live");
    setCurrentIndex(Math.max(0, toolCalls.length - 1));
  }, [toolCalls.length]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "i") {
        e.preventDefault();
        setToolPanelOpen(false);
      }
      if (panelMode === "tools") {
        if (e.key === "ArrowLeft" && hasPrev) navigateTo(displayIndex - 1);
        if (e.key === "ArrowRight" && hasNext) navigateTo(displayIndex + 1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayIndex, hasPrev, hasNext, navigateTo, setToolPanelOpen, panelMode]);

  return (
    <div className="fixed inset-y-0 right-0 w-[550px] z-30 flex flex-col bg-card/95 backdrop-blur-xl border-l border-border/50">
      {/* Header with tab bar */}
      <div className="flex-shrink-0 border-b border-border/30">
        {/* Branding */}
        <div className="px-3 pt-2 pb-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            BitterBot&apos;s Computer
          </span>
        </div>
        <div className="h-12 flex items-center justify-between px-3">
          <div className="flex items-center gap-1">
            {/* Tab bar */}
            <TabButton
              active={panelMode === "tools"}
              icon={<Terminal className="w-3.5 h-3.5" />}
              label="Tools"
              onClick={() => setPanelMode("tools")}
            />
            {hasArtifacts && (
              <TabButton
                active={panelMode === "artifact"}
                icon={<Code className="w-3.5 h-3.5" />}
                label="Artifact"
                onClick={() => setPanelMode("artifact")}
              />
            )}
            {hasTasks && (
              <TabButton
                active={panelMode === "tasks"}
                icon={<ListTree className="w-3.5 h-3.5" />}
                label="Tasks"
                onClick={() => setPanelMode("tasks")}
              />
            )}
            <TabButton
              active={panelMode === "files"}
              icon={<FolderOpen className="w-3.5 h-3.5" />}
              label="Files"
              onClick={() => setPanelMode("files")}
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Live/Manual status button (tools mode only) */}
            {panelMode === "tools" && toolCalls.length > 0 && (
              <StatusButton navMode={navMode} isRunning={anyRunning} onJumpToLive={jumpToLive} />
            )}

            <button
              onClick={() => setToolPanelOpen(false)}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Panel content */}
      {panelMode === "artifact" ? (
        <ArtifactPanel />
      ) : panelMode === "tasks" ? (
        <CoworkPanel />
      ) : panelMode === "files" ? (
        <WorkspaceFilesPanel />
      ) : (
        <>
          {/* Tool call content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {currentCall ? (
              <>
                <ToolHeader toolCall={currentCall} />
                <div className="flex-1 overflow-hidden">
                  <ToolView toolCall={currentCall} />
                </div>
                <ToolFooter toolCall={currentCall} />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-2 text-muted-foreground">
                  <Terminal className="w-8 h-8 mx-auto opacity-50" />
                  <p className="text-sm">No tool calls yet</p>
                  <p className="text-xs">Tool calls will appear here when the agent uses tools.</p>
                </div>
              </div>
            )}
          </div>

          {/* Navigation bar */}
          {toolCalls.length > 1 && (
            <div className="flex-shrink-0 px-3 py-2 border-t border-border/30 bg-card/60">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => navigateTo(displayIndex - 1)}
                  disabled={!hasPrev}
                  className={cn(
                    "w-7 h-7 flex items-center justify-center rounded-md transition-colors",
                    hasPrev
                      ? "hover:bg-accent text-muted-foreground hover:text-foreground"
                      : "text-muted-foreground/30 cursor-not-allowed",
                  )}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                <span className="text-xs text-muted-foreground font-medium tabular-nums min-w-[44px] text-center">
                  {displayIndex + 1}/{toolCalls.length}
                </span>

                <button
                  onClick={() => navigateTo(displayIndex + 1)}
                  disabled={!hasNext}
                  className={cn(
                    "w-7 h-7 flex items-center justify-center rounded-md transition-colors",
                    hasNext
                      ? "hover:bg-accent text-muted-foreground hover:text-foreground"
                      : "text-muted-foreground/30 cursor-not-allowed",
                  )}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>

                <div className="flex-1 px-1">
                  <input
                    type="range"
                    min={0}
                    max={toolCalls.length - 1}
                    step={1}
                    value={displayIndex}
                    onChange={(e) => navigateTo(Number(e.target.value))}
                    className="w-full h-1.5 rounded-full bg-zinc-700/50 appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                      [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400
                      [&::-webkit-slider-thumb]:hover:bg-purple-300 [&::-webkit-slider-thumb]:transition-colors"
                  />
                </div>

                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <CheckCircle className="w-3 h-3 text-emerald-400/70" />
                  <span>{completedCount}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Tab button for switching between Tools and Artifact views. */
function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
        active
          ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
          : "text-muted-foreground hover:text-foreground hover:bg-accent",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Status button: shows live/manual mode and allows jumping to live. */
function StatusButton({
  navMode,
  isRunning,
  onJumpToLive,
}: {
  navMode: NavigationMode;
  isRunning: boolean;
  onJumpToLive: () => void;
}) {
  if (navMode === "live") {
    if (isRunning) {
      return (
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] font-medium text-emerald-400">Live</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-500/10 border border-zinc-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
        <span className="text-[10px] font-medium text-zinc-400">Latest</span>
      </div>
    );
  }

  return (
    <button
      onClick={onJumpToLive}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-colors cursor-pointer",
        isRunning
          ? "bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20"
          : "bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20",
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          isRunning ? "bg-emerald-400 animate-pulse" : "bg-blue-400",
        )}
      />
      <span
        className={cn("text-[10px] font-medium", isRunning ? "text-emerald-400" : "text-blue-400")}
      >
        {isRunning ? "Jump to Live" : "Jump to Latest"}
      </span>
    </button>
  );
}

/** Get a contextual subtitle for the tool header. */
function getToolSubtitle(toolCall: ActiveToolCall): string | null {
  const args = toolCall.args as Record<string, unknown> | undefined;
  if (!args) return null;
  const lower = toolCall.name.toLowerCase();

  // Commands: show the command string
  if (
    lower.includes("command") ||
    lower.includes("execute") ||
    lower.includes("shell") ||
    lower.includes("terminal")
  ) {
    const cmd =
      typeof args.command === "string"
        ? args.command
        : typeof args.cmd === "string"
          ? args.cmd
          : null;
    if (cmd) return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  }
  // File ops: show file path
  const fp = extractFilePath(args);
  if (fp) {
    const short = fp.split("/").slice(-2).join("/");
    return short;
  }
  // Search: show query
  if (lower.includes("search")) {
    const q =
      typeof args.query === "string"
        ? args.query
        : typeof args.search_query === "string"
          ? args.search_query
          : typeof args.q === "string"
            ? args.q
            : null;
    if (q) return q;
  }
  // Browser/web: show URL
  if (
    lower.includes("browser") ||
    lower.includes("web") ||
    lower.includes("crawl") ||
    lower.includes("scrape")
  ) {
    const url =
      typeof args.url === "string"
        ? args.url
        : typeof args.target_url === "string"
          ? args.target_url
          : null;
    if (url) return url.length > 60 ? url.slice(0, 57) + "..." : url;
  }
  return null;
}

/** Get contextual footer badges for a tool call. */
function getToolFooterBadges(toolCall: ActiveToolCall): Array<{ label: string; color: string }> {
  const badges: Array<{ label: string; color: string }> = [];
  const output = toolCall.result ?? toolCall.partialResult ?? "";
  const args = toolCall.args as Record<string, unknown> | undefined;
  const lower = toolCall.name.toLowerCase();

  // Exit code for commands
  if (
    lower.includes("command") ||
    lower.includes("execute") ||
    lower.includes("shell") ||
    lower.includes("terminal")
  ) {
    const code = parseExitCode(output);
    if (code !== null) {
      badges.push({
        label: `Exit ${code}`,
        color:
          code === 0
            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
            : "bg-red-500/10 text-red-400 border-red-500/20",
      });
    }
  }

  // Language badge for file ops
  if (args) {
    const fp = extractFilePath(args);
    if (fp) {
      const ext = fp.split(".").pop()?.toLowerCase();
      if (ext) {
        const lang = getLanguageFromExtension(ext);
        if (lang !== "text") {
          badges.push({ label: lang, color: "bg-blue-500/10 text-blue-400 border-blue-500/20" });
        }
      }
    }
  }

  // Result count for search
  if (lower.includes("search") && output) {
    try {
      const parsed = JSON.parse(output);
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.results)
          ? parsed.results
          : Array.isArray(parsed.organic_results)
            ? parsed.organic_results
            : null;
      if (items) {
        badges.push({
          label: `${items.length} results`,
          color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
        });
      }
    } catch {
      /* not JSON */
    }
  }

  return badges;
}

/** Tool header bar showing icon, name, subtitle, and status badge. */
function ToolHeader({ toolCall }: { toolCall: ActiveToolCall }) {
  const { icon: Icon, color, gradient } = getToolMeta(toolCall.name);
  const displayName = getToolDisplayName(toolCall.name);
  const subtitle = getToolSubtitle(toolCall);

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 border-b border-border/20 flex-shrink-0">
      <div
        className={cn(
          "w-7 h-7 rounded-lg bg-gradient-to-br flex items-center justify-center flex-shrink-0",
          gradient,
        )}
      >
        <Icon className={cn("w-3.5 h-3.5", color)} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-foreground">{displayName}</span>
        {subtitle && (
          <div className="text-[10px] text-muted-foreground/70 font-mono truncate mt-0.5">
            {subtitle}
          </div>
        )}
      </div>
      <span
        className={cn(
          "flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full flex-shrink-0",
          toolCall.status === "running"
            ? "bg-emerald-500/10 text-emerald-400"
            : toolCall.status === "error"
              ? "bg-red-500/10 text-red-400"
              : "bg-purple-500/10 text-purple-400",
        )}
      >
        {toolCall.status === "running" && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        )}
        {toolCall.status === "completed" && <CheckCircle className="w-2.5 h-2.5" />}
        {toolCall.status === "error" && <AlertTriangle className="w-2.5 h-2.5" />}
        {toolCall.status}
      </span>
    </div>
  );
}

/** Tool footer showing contextual badges and timestamp. */
function ToolFooter({ toolCall }: { toolCall: ActiveToolCall }) {
  if (!toolCall.timestamp) return null;
  const time = new Date(toolCall.timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const badges = getToolFooterBadges(toolCall);

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/20 flex-shrink-0">
      <div className="flex items-center gap-1.5">
        {badges.map((badge, i) => (
          <span
            key={i}
            className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded border", badge.color)}
          >
            {badge.label}
          </span>
        ))}
      </div>
      <span className="text-[10px] text-muted-foreground/60">{time}</span>
    </div>
  );
}
