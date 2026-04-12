import { Search, ExternalLink, Globe, Image, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { cn } from "../../../lib/utils";
import { safeJsonParse, getFaviconUrl, extractDomain, classifyResultType } from "./tool-view-utils";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchData {
  results: SearchResult[];
  images: Array<{ url: string; title?: string }>;
  answer?: string;
  query?: string;
}

/** Parse search results from tool output — handles Tavily JSON and text formats. */
function parseSearchResults(output: string): SearchData {
  const data: SearchData = { results: [], images: [] };

  // Try JSON format first
  const parsed = safeJsonParse<Record<string, unknown>>(output, {});
  if (parsed && typeof parsed === "object") {
    // Tavily / structured JSON
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>).results)
        ? ((parsed as Record<string, unknown>).results as unknown[])
        : Array.isArray((parsed as Record<string, unknown>).organic_results)
          ? ((parsed as Record<string, unknown>).organic_results as unknown[])
          : [];

    for (const item of items as Record<string, unknown>[]) {
      if (item && typeof item === "object") {
        data.results.push({
          title: (item.title ?? item.name ?? "") as string,
          url: (item.url ?? item.link ?? item.href ?? "") as string,
          snippet: (item.snippet ?? item.description ?? item.content ?? item.text ?? "") as string,
        });
      }
    }

    // Extract images array
    const imgs = (parsed as Record<string, unknown>).images;
    if (Array.isArray(imgs)) {
      for (const img of imgs) {
        if (typeof img === "string") {
          data.images.push({ url: img });
        } else if (img && typeof img === "object") {
          const imgObj = img as Record<string, unknown>;
          const url = (imgObj.url ?? imgObj.src ?? imgObj.image_url) as string;
          if (url) data.images.push({ url, title: imgObj.title as string | undefined });
        }
      }
    }

    // Extract answer
    if (typeof (parsed as Record<string, unknown>).answer === "string") {
      data.answer = (parsed as Record<string, unknown>).answer as string;
    }

    if (data.results.length > 0) return data;
  }

  // Fallback: text-based parsing
  const lines = output.split("\n");
  let current: Partial<SearchResult> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    const titleMatch = trimmed.match(/^(?:\d+\.\s+|\*\s+|-\s+)(.+)/);
    if (titleMatch) {
      if (current.title) {
        data.results.push({
          title: current.title,
          url: current.url ?? "",
          snippet: current.snippet ?? "",
        });
      }
      current = { title: titleMatch[1] };
      continue;
    }
    const urlMatch = trimmed.match(/^(https?:\/\/\S+)/);
    if (urlMatch && current.title) {
      current.url = urlMatch[1];
      continue;
    }
    if (current.title && trimmed && !current.snippet) {
      current.snippet = trimmed;
    }
  }
  if (current.title) {
    data.results.push({
      title: current.title,
      url: current.url ?? "",
      snippet: current.snippet ?? "",
    });
  }

  return data;
}

const TYPE_COLORS: Record<string, string> = {
  Wiki: "bg-blue-500/15 text-blue-400",
  GitHub: "bg-zinc-500/15 text-zinc-300",
  "Q&A": "bg-orange-500/15 text-orange-400",
  Docs: "bg-green-500/15 text-green-400",
  Blog: "bg-pink-500/15 text-pink-400",
  Reddit: "bg-orange-500/15 text-orange-300",
  Video: "bg-red-500/15 text-red-400",
  Paper: "bg-violet-500/15 text-violet-400",
  Package: "bg-emerald-500/15 text-emerald-400",
  Website: "bg-zinc-500/10 text-zinc-400",
};

export function WebSearchToolView({ toolCall }: ToolViewProps) {
  const [expandedSnippets, setExpandedSnippets] = useState<Set<number>>(new Set());
  const [showAllImages, setShowAllImages] = useState(false);

  const args = toolCall.args as Record<string, unknown> | undefined;
  const query =
    typeof args?.query === "string"
      ? args.query
      : typeof args?.search_query === "string"
        ? args.search_query
        : typeof args?.q === "string"
          ? args.q
          : null;

  const output = toolCall.result ?? toolCall.partialResult;
  const isRunning = toolCall.status === "running";

  const searchData = output
    ? parseSearchResults(output)
    : { results: [], images: [], answer: undefined };
  const { results: searchResults, images, answer } = searchData;

  const toggleSnippet = (i: number) => {
    setExpandedSnippets((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const visibleImages = showAllImages ? images : images.slice(0, 6);

  return (
    <div className="flex flex-col h-full">
      {/* Query bar */}
      {query && (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-zinc-800/40 border-b border-zinc-800/30">
          <Search className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
          <span className="text-sm text-zinc-200 font-medium">{query}</span>
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {isRunning && !output ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Search className="w-6 h-6 text-cyan-400 animate-pulse" />
            <span className="text-sm text-zinc-400">Searching the web...</span>
            {query && <span className="text-xs text-zinc-500 font-mono">"{query}"</span>}
          </div>
        ) : searchResults.length > 0 ? (
          <div className="p-3 space-y-3">
            {/* Result count header */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-500 font-medium">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Answer box */}
            {answer && (
              <div className="p-3 rounded-lg bg-cyan-500/5 border border-cyan-500/15 text-sm text-zinc-300 leading-relaxed">
                {answer}
              </div>
            )}

            {/* Image grid */}
            {images.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-medium uppercase tracking-wider">
                  <Image className="w-3 h-3" />
                  Images
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {visibleImages.map((img, i) => (
                    <div
                      key={i}
                      className="aspect-video rounded-md overflow-hidden bg-zinc-800/50 border border-zinc-700/30"
                    >
                      <img
                        src={img.url}
                        alt={img.title ?? "Search image"}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    </div>
                  ))}
                </div>
                {images.length > 6 && !showAllImages && (
                  <button
                    onClick={() => setShowAllImages(true)}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 transition-colors"
                  >
                    View {images.length - 6} more images
                  </button>
                )}
              </div>
            )}

            {/* Result cards */}
            {searchResults.map((result, i) => {
              const resultType = classifyResultType(result);
              const isExpanded = expandedSnippets.has(i);

              return (
                <div
                  key={i}
                  className="p-2.5 rounded-lg bg-zinc-900/40 border border-zinc-800/30 hover:border-zinc-700/50 transition-colors"
                >
                  <div className="flex items-start gap-2.5">
                    {/* Favicon */}
                    {result.url && (
                      <img
                        src={getFaviconUrl(result.url)}
                        alt=""
                        className="w-4 h-4 rounded-sm mt-0.5 flex-shrink-0"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    )}

                    <div className="flex-1 min-w-0">
                      {/* Title + type badge */}
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-blue-400 truncate flex-1">
                          {result.title || "Untitled"}
                        </span>
                        <span
                          className={cn(
                            "text-[9px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 uppercase tracking-wider",
                            TYPE_COLORS[resultType] ?? TYPE_COLORS.Website,
                          )}
                        >
                          {resultType}
                        </span>
                      </div>

                      {/* URL */}
                      {result.url && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <Globe className="w-2.5 h-2.5 text-zinc-500 flex-shrink-0" />
                          <span className="text-[10px] text-zinc-500 truncate font-mono">
                            {extractDomain(result.url)}
                          </span>
                        </div>
                      )}

                      {/* Snippet */}
                      {result.snippet && (
                        <p
                          className={cn(
                            "text-xs text-zinc-400 mt-1.5 leading-relaxed cursor-pointer",
                            !isExpanded && "line-clamp-2",
                          )}
                          onClick={() => toggleSnippet(i)}
                        >
                          {result.snippet}
                          {!isExpanded && result.snippet.length > 150 && (
                            <span className="text-zinc-500 ml-1 inline-flex items-center">
                              <ChevronDown className="w-3 h-3" />
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : output ? (
          <pre className="p-3 font-mono text-xs text-zinc-300 whitespace-pre-wrap break-words">
            {output}
          </pre>
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            No results
          </div>
        )}
      </div>
    </div>
  );
}
