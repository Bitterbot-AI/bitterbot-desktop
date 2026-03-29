import type { ActiveToolCall } from "../../../stores/chat-store";
import { CommandToolView } from "./CommandToolView";
import { FileToolView } from "./FileToolView";
import { StrReplaceToolView } from "./StrReplaceToolView";
import { BrowserToolView } from "./BrowserToolView";
import { WebSearchToolView } from "./WebSearchToolView";
import { WebCrawlToolView } from "./WebCrawlToolView";
import { GenericToolView } from "./GenericToolView";
import { ArtifactToolView } from "./ArtifactToolView";
import { CodeInterpreterView } from "./CodeInterpreterView";
import { CompleteToolView } from "./CompleteToolView";
import { AskToolView } from "./AskToolView";

export interface ToolViewProps {
  toolCall: ActiveToolCall;
}

type ToolViewComponent = React.ComponentType<ToolViewProps>;

/**
 * Map tool names to specialized view components.
 * Falls back to GenericToolView for unrecognized tools.
 */
const TOOL_VIEW_MAP: Record<string, ToolViewComponent> = {
  // Command / terminal tools
  "execute-command": CommandToolView,
  "execute_command": CommandToolView,
  "run-command": CommandToolView,
  "run_command": CommandToolView,
  "shell": CommandToolView,
  "terminal": CommandToolView,
  "terminate-command": CommandToolView,
  "terminate_command": CommandToolView,

  // Str-replace / edit tools (dedicated diff view)
  "str-replace-editor": StrReplaceToolView,
  "str_replace_editor": StrReplaceToolView,
  "str-replace": StrReplaceToolView,
  "str_replace": StrReplaceToolView,

  // File tools
  "read-file": FileToolView,
  "read_file": FileToolView,
  "write-file": FileToolView,
  "write_file": FileToolView,
  "create-file": FileToolView,
  "create_file": FileToolView,
  "edit-file": FileToolView,
  "edit_file": FileToolView,
  "list-directory": FileToolView,
  "list_directory": FileToolView,
  "file-operation": FileToolView,
  "file_operation": FileToolView,
  "delete-file": FileToolView,
  "delete_file": FileToolView,

  // Browser tools
  "browser-action": BrowserToolView,
  "browser_action": BrowserToolView,
  "browser-navigate": BrowserToolView,
  "browser_navigate": BrowserToolView,
  "take-screenshot": BrowserToolView,
  "take_screenshot": BrowserToolView,
  "see-image": BrowserToolView,

  // Web search tools
  "web-search": WebSearchToolView,
  "web_search": WebSearchToolView,
  "search": WebSearchToolView,
  "search-web": WebSearchToolView,
  "search_web": WebSearchToolView,

  // Web crawl / scrape tools
  "web-crawl": WebCrawlToolView,
  "web_crawl": WebCrawlToolView,
  "web-scrape": WebCrawlToolView,
  "web_scrape": WebCrawlToolView,
  "scrape-webpage": WebCrawlToolView,
  "scrape_webpage": WebCrawlToolView,
  "crawl-webpage": WebCrawlToolView,
  "crawl_webpage": WebCrawlToolView,

  // Artifact tools
  "create-artifact": ArtifactToolView,
  "create_artifact": ArtifactToolView,

  // Code interpreter tools
  "code-interpreter": CodeInterpreterView,
  "code_interpreter": CodeInterpreterView,

  // Workflow tools
  "complete": CompleteToolView,
  "task-complete": CompleteToolView,
  "task_complete": CompleteToolView,

  // Ask / user interaction tools
  "ask": AskToolView,
  "ask-user": AskToolView,
  "ask_user": AskToolView,
};

export function getToolView(toolName: string): ToolViewComponent {
  const lower = toolName.toLowerCase();
  // Exact match
  if (TOOL_VIEW_MAP[lower]) return TOOL_VIEW_MAP[lower];

  // Substring match fallback — order matters (more specific first)
  if (lower.includes("str-replace") || lower.includes("str_replace"))
    return StrReplaceToolView;
  if (lower.includes("command") || lower.includes("execute") || lower.includes("shell") || lower.includes("terminal"))
    return CommandToolView;
  if (lower.includes("file") || lower.includes("write") || lower.includes("read") || lower.includes("edit"))
    return FileToolView;
  if (lower.includes("browser") || lower.includes("screenshot") || lower.includes("see-image") || lower.includes("see_image"))
    return BrowserToolView;
  if (lower.includes("crawl") || lower.includes("scrape"))
    return WebCrawlToolView;
  if (lower.includes("search"))
    return WebSearchToolView;
  if (lower.includes("artifact"))
    return ArtifactToolView;
  if (lower.includes("code_interpreter") || lower.includes("code-interpreter"))
    return CodeInterpreterView;
  if (lower === "complete" || lower.includes("task_complete") || lower.includes("task-complete"))
    return CompleteToolView;
  if (lower === "ask" || lower.includes("ask_user") || lower.includes("ask-user"))
    return AskToolView;

  return GenericToolView;
}

export function ToolView({ toolCall }: ToolViewProps) {
  const Component = getToolView(toolCall.name);
  return <Component toolCall={toolCall} />;
}
