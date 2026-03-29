import { useState, useCallback, useMemo } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { Globe, ExternalLink, Copy, Check, FileText, Loader2 } from "lucide-react";
import { cn } from "../../../lib/utils";
import { extractDomain, getFaviconUrl, getContentStats } from "./tool-view-utils";

export function WebCrawlToolView({ toolCall }: ToolViewProps) {
  const [copied, setCopied] = useState(false);

  const args = toolCall.args as Record<string, unknown> | undefined;
  const url =
    typeof args?.url === "string"
      ? args.url
      : typeof args?.target_url === "string"
        ? args.target_url
        : null;

  const output = toolCall.result ?? toolCall.partialResult;
  const isRunning = toolCall.status === "running";

  const stats = useMemo(() => (output ? getContentStats(output) : null), [output]);

  const handleCopy = useCallback(() => {
    if (output) {
      navigator.clipboard.writeText(output).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }, [output]);

  const domain = url ? extractDomain(url) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Source URL card */}
      {url && (
        <div className="flex items-center gap-2.5 px-3 py-2.5 bg-zinc-900/60 border-b border-zinc-800/50">
          <img
            src={getFaviconUrl(url)}
            alt=""
            className="w-4 h-4 rounded-sm flex-shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-300 font-medium truncate">{domain}</div>
            <div className="text-[10px] text-zinc-500 font-mono truncate">{url}</div>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded hover:bg-zinc-700/50 transition-colors text-zinc-500 hover:text-zinc-300 flex-shrink-0"
            title="Open in browser"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}

      {/* Content stats bar */}
      {stats && stats.words > 0 && (
        <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-900/40 border-b border-zinc-800/30">
          <div className="flex items-center gap-1.5">
            <FileText className="w-3 h-3 text-zinc-500" />
            <span className="text-[10px] text-zinc-500">
              {stats.words.toLocaleString()} words
            </span>
          </div>
          <span className="text-[10px] text-zinc-600">
            {stats.chars.toLocaleString()} chars
          </span>
          <span className="text-[10px] text-zinc-600">
            {stats.lines.toLocaleString()} lines
          </span>
          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="ml-auto p-1 rounded hover:bg-zinc-700/50 transition-colors text-zinc-500 hover:text-zinc-300"
            title="Copy content"
          >
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-auto">
        {output ? (
          <pre className="p-3 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">
            {output}
          </pre>
        ) : isRunning ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Loader2 className="w-5 h-5 text-green-400 animate-spin" />
            <span className="text-sm text-zinc-400">Crawling page...</span>
            {url && (
              <span className="text-xs text-zinc-500 font-mono">{domain}</span>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            No content extracted
          </div>
        )}
      </div>
    </div>
  );
}
