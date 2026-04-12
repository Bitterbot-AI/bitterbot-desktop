import { Search, X, CaseSensitive, Regex, FileCode, Loader2 } from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "../../lib/utils";
import { useWorkspaceStore, type SearchResult } from "../../stores/workspace-store";
import { getFileIcon } from "./workspace-utils";

export function ContentSearchPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const searchContent = useWorkspaceStore((s) => s.searchContent);
  const searchResults = useWorkspaceStore((s) => s.searchResults);
  const searchLoading = useWorkspaceStore((s) => s.searchLoading);
  const clearSearch = useWorkspaceStore((s) => s.clearSearch);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(
    (q: string, cs: boolean, rx: boolean) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim()) {
        clearSearch();
        return;
      }
      debounceRef.current = setTimeout(() => {
        searchContent(q, { caseSensitive: cs, regex: rx });
      }, 300);
    },
    [searchContent, clearSearch],
  );

  const handleQueryChange = (val: string) => {
    setQuery(val);
    doSearch(val, caseSensitive, regex);
  };

  const toggleCaseSensitive = () => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    doSearch(query, next, regex);
  };

  const toggleRegex = () => {
    const next = !regex;
    setRegex(next);
    doSearch(query, caseSensitive, next);
  };

  // Group results by file
  const grouped = searchResults.reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.path] ??= []).push(r);
    return acc;
  }, {});
  const fileCount = Object.keys(grouped).length;

  return (
    <div className="flex flex-col h-full">
      {/* Search header */}
      <div className="flex-shrink-0 flex items-center gap-1.5 px-2 py-2 border-b border-zinc-800/40">
        <Search className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search in files..."
          className="flex-1 bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 border-none outline-none font-mono"
        />
        <button
          onClick={toggleCaseSensitive}
          className={cn(
            "w-5 h-5 flex items-center justify-center rounded transition-colors",
            caseSensitive
              ? "bg-purple-500/20 text-purple-300"
              : "text-zinc-500 hover:text-zinc-300",
          )}
          title="Case sensitive"
        >
          <CaseSensitive className="w-3 h-3" />
        </button>
        <button
          onClick={toggleRegex}
          className={cn(
            "w-5 h-5 flex items-center justify-center rounded transition-colors",
            regex ? "bg-purple-500/20 text-purple-300" : "text-zinc-500 hover:text-zinc-300",
          )}
          title="Regex"
        >
          <Regex className="w-3 h-3" />
        </button>
        <button
          onClick={onClose}
          className="w-5 h-5 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
          title="Close search"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Summary */}
      {query.trim() && (
        <div className="flex-shrink-0 px-3 py-1 text-[10px] text-zinc-500 border-b border-zinc-800/20">
          {searchLoading ? (
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching...
            </span>
          ) : (
            `${searchResults.length} result${searchResults.length !== 1 ? "s" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}`
          )}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto scrollbar-none">
        {Object.entries(grouped).map(([filePath, results]) => {
          const fileName = filePath.split("/").pop() ?? filePath;
          const Icon = getFileIcon(fileName);
          return (
            <div key={filePath}>
              {/* File header */}
              <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900/40 sticky top-0">
                <Icon className="w-3 h-3 text-blue-400/60 flex-shrink-0" />
                <span className="text-[11px] font-mono text-zinc-400 truncate">{filePath}</span>
                <span className="ml-auto text-[10px] text-zinc-600">{results.length}</span>
              </div>
              {/* Line results */}
              {results.map((r, i) => (
                <button
                  key={`${r.line}-${i}`}
                  onClick={() => openFile(filePath)}
                  className="w-full flex items-center gap-2 px-3 py-[3px] text-left hover:bg-[rgba(139,92,246,0.06)] transition-colors"
                >
                  <span className="text-[10px] text-zinc-600 w-8 text-right flex-shrink-0 font-mono">
                    {r.line}
                  </span>
                  <span className="text-[11px] text-zinc-400 font-mono truncate">{r.content}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
