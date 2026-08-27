import {
  FileCode,
  FilePlus,
  FileEdit,
  FileSearch,
  FileX,
  FolderOpen,
  Copy,
  Check,
} from "lucide-react";
import { useState, useCallback } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { cn } from "../../../lib/utils";
import { SyntaxViewer } from "../../workspace/SyntaxViewer";
import { extractFilePath, getLanguageFromExtension } from "./tool-view-utils";

/** Detect which file operation this is and pick an icon + color. */
function getFileOp(name: string): {
  label: string;
  Icon: typeof FileCode;
  color: string;
  iconColor: string;
} {
  const lower = name.toLowerCase();
  if (lower.includes("write") || lower.includes("create"))
    return {
      label: "Create File",
      Icon: FilePlus,
      color: "border-success/20",
      iconColor: "text-success",
    };
  if (lower.includes("edit") || lower.includes("replace"))
    return {
      label: "Edit File",
      Icon: FileEdit,
      color: "border-info/20",
      iconColor: "text-info",
    };
  if (lower.includes("read"))
    return {
      label: "Read File",
      Icon: FileSearch,
      color: "border-info/20",
      iconColor: "text-info",
    };
  if (lower.includes("delete"))
    return {
      label: "Delete File",
      Icon: FileX,
      color: "border-danger/20",
      iconColor: "text-danger",
    };
  if (lower.includes("list") || lower.includes("directory"))
    return {
      label: "List Directory",
      Icon: FolderOpen,
      color: "border-info/20",
      iconColor: "text-info",
    };
  return {
    label: "File Operation",
    Icon: FileCode,
    color: "border-info/20",
    iconColor: "text-info",
  };
}

/** Get language from file path extension. */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return getLanguageFromExtension(ext);
}

/** Get a simple display name for a language. */
function getLangDisplayName(lang: string): string {
  const map: Record<string, string> = {
    typescript: "TypeScript",
    tsx: "TSX",
    javascript: "JavaScript",
    jsx: "JSX",
    python: "Python",
    rust: "Rust",
    go: "Go",
    java: "Java",
    ruby: "Ruby",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    toml: "TOML",
    markdown: "Markdown",
    bash: "Shell",
    sql: "SQL",
    xml: "XML",
    c: "C",
    cpp: "C++",
    csharp: "C#",
    swift: "Swift",
    kotlin: "Kotlin",
    php: "PHP",
    lua: "Lua",
    r: "R",
    text: "",
  };
  return map[lang] ?? lang.toUpperCase();
}

export function FileToolView({ toolCall }: ToolViewProps) {
  const [copied, setCopied] = useState(false);
  const [cachedHtml, setCachedHtml] = useState<string | null>(null);

  const args = toolCall.args as Record<string, unknown> | undefined;
  const filePath = extractFilePath(args);

  const { label, Icon, iconColor } = getFileOp(toolCall.name);
  const language = filePath ? getLanguageFromPath(filePath) : "text";
  const langDisplay = getLangDisplayName(language);
  const output = toolCall.result ?? toolCall.partialResult;
  const isRunning = toolCall.status === "running";
  const isDelete = toolCall.name.toLowerCase().includes("delete");

  const handleCopy = useCallback(() => {
    if (output) {
      navigator.clipboard.writeText(output).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }, [output]);

  const handleHighlighted = useCallback((html: string) => {
    setCachedHtml(html);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-card/60 border-b border-border/50">
        <Icon className={cn("w-3.5 h-3.5", iconColor)} />
        <span className="text-xs font-medium text-foreground">{label}</span>
        {langDisplay && (
          <span className="text-badge text-muted-foreground ml-auto">{langDisplay}</span>
        )}
        {/* Copy button */}
        {output && (
          <button
            onClick={handleCopy}
            className="ml-1 p-1 rounded hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
            title="Copy content"
          >
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
          </button>
        )}
      </div>

      {/* File path */}
      {filePath && (
        <div className="px-3 py-1.5 bg-card/40 border-b border-border/30 font-mono text-2xs text-muted-foreground truncate">
          {filePath}
        </div>
      )}

      {/* Content area */}
      {isDelete && !output ? (
        /* Delete file view */
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <FileX className="w-10 h-10 text-danger/60" />
          <span className="text-sm font-medium text-danger">File Deleted</span>
          {filePath && <span className="text-xs text-muted-foreground font-mono">{filePath}</span>}
        </div>
      ) : output && language !== "text" ? (
        /* Syntax-highlighted view */
        <SyntaxViewer
          code={output}
          language={language}
          cachedHtml={cachedHtml}
          onHighlighted={handleHighlighted}
        />
      ) : (
        /* Plain text fallback */
        <pre className="flex-1 overflow-auto p-3 bg-card/60 font-mono text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
          {output ? (
            output
          ) : isRunning ? (
            <span className="text-muted-foreground animate-pulse">Processing file...</span>
          ) : (
            <span className="text-muted-foreground">No content</span>
          )}
        </pre>
      )}
    </div>
  );
}
