import { useState, useCallback } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
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
    return { label: "Create File", Icon: FilePlus, color: "border-emerald-500/20", iconColor: "text-emerald-400" };
  if (lower.includes("edit") || lower.includes("replace"))
    return { label: "Edit File", Icon: FileEdit, color: "border-blue-500/20", iconColor: "text-blue-400" };
  if (lower.includes("read"))
    return { label: "Read File", Icon: FileSearch, color: "border-blue-500/20", iconColor: "text-blue-400" };
  if (lower.includes("delete"))
    return { label: "Delete File", Icon: FileX, color: "border-red-500/20", iconColor: "text-red-400" };
  if (lower.includes("list") || lower.includes("directory"))
    return { label: "List Directory", Icon: FolderOpen, color: "border-blue-500/20", iconColor: "text-blue-400" };
  return { label: "File Operation", Icon: FileCode, color: "border-blue-500/20", iconColor: "text-blue-400" };
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
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800/50">
        <Icon className={cn("w-3.5 h-3.5", iconColor)} />
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        {langDisplay && (
          <span className="text-[10px] text-zinc-500 ml-auto">{langDisplay}</span>
        )}
        {/* Copy button */}
        {output && (
          <button
            onClick={handleCopy}
            className="ml-1 p-1 rounded hover:bg-zinc-700/50 transition-colors text-zinc-500 hover:text-zinc-300"
            title="Copy content"
          >
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        )}
      </div>

      {/* File path */}
      {filePath && (
        <div className="px-3 py-1.5 bg-zinc-900/40 border-b border-zinc-800/30 font-mono text-[11px] text-zinc-400 truncate">
          {filePath}
        </div>
      )}

      {/* Content area */}
      {isDelete && !output ? (
        /* Delete file view */
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
          <FileX className="w-10 h-10 text-red-400/60" />
          <span className="text-sm font-medium text-red-400">File Deleted</span>
          {filePath && (
            <span className="text-xs text-zinc-500 font-mono">{filePath}</span>
          )}
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
        <pre className="flex-1 overflow-auto p-3 bg-zinc-950/60 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">
          {output ? (
            output
          ) : isRunning ? (
            <span className="text-zinc-500 animate-pulse">Processing file...</span>
          ) : (
            <span className="text-zinc-600">No content</span>
          )}
        </pre>
      )}
    </div>
  );
}
