import { useCallback, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useLogsStore } from "../../stores/logs-store";

const POLL_INTERVAL_MS = 2000;
const LOG_LEVELS = ["info", "warn", "error", "debug"] as const;

function parseLogLevel(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("[error]") || lower.includes(" error ") || lower.includes("err:"))
    return "error";
  if (lower.includes("[warn]") || lower.includes(" warn ") || lower.includes("warning"))
    return "warn";
  if (lower.includes("[debug]") || lower.includes(" debug ")) return "debug";
  return "info";
}

function LogLine({ text, levelFilter }: { text: string; levelFilter: Set<string> }) {
  const level = parseLogLevel(text);
  if (!levelFilter.has(level)) return null;

  return (
    <div
      className={cn(
        "px-4 py-0.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all",
        level === "error" && "text-red-400",
        level === "warn" && "text-yellow-400",
        level === "debug" && "text-muted-foreground/60",
        level === "info" && "text-foreground/80",
      )}
    >
      {text}
    </div>
  );
}

export function LogsView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const lines = useLogsStore((s) => s.lines);
  const cursor = useLogsStore((s) => s.cursor);
  const autoScroll = useLogsStore((s) => s.autoScroll);
  const filter = useLogsStore((s) => s.filter);
  const levelFilter = useLogsStore((s) => s.levelFilter);
  const loading = useLogsStore((s) => s.loading);
  const setLines = useLogsStore((s) => s.setLines);
  const appendLines = useLogsStore((s) => s.appendLines);
  const setCursor = useLogsStore((s) => s.setCursor);
  const setAutoScroll = useLogsStore((s) => s.setAutoScroll);
  const setFilter = useLogsStore((s) => s.setFilter);
  const toggleLevel = useLogsStore((s) => s.toggleLevel);
  const setLoading = useLogsStore((s) => s.setLoading);
  const clear = useLogsStore((s) => s.clear);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval>>();

  const fetchLogs = useCallback(async () => {
    if (gwStatus !== "connected") return;
    try {
      const params: Record<string, unknown> = { limit: 500 };
      if (cursor != null) params.cursor = cursor;
      const res = (await request("logs.tail", params)) as {
        lines?: string[];
        cursor?: number;
        reset?: boolean;
      };
      if (res.lines && res.lines.length > 0) {
        if (res.reset || cursor == null) {
          setLines(res.lines);
        } else {
          appendLines(res.lines);
        }
      }
      if (typeof res.cursor === "number") {
        setCursor(res.cursor);
      }
    } catch {
      // Silently retry on next poll
    }
  }, [gwStatus, request, cursor, setLines, appendLines, setCursor]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchLogs().finally(() => setLoading(false));
  }, [gwStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling
  useEffect(() => {
    pollingRef.current = setInterval(fetchLogs, POLL_INTERVAL_MS);
    return () => clearInterval(pollingRef.current);
  }, [fetchLogs]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const filteredLines = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border/20">
        <h2 className="text-sm font-medium text-foreground/80">Logs</h2>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className={cn(
            "h-7 px-2 text-xs rounded border bg-transparent flex-1 max-w-xs",
            "border-border/30 focus:border-purple-500 focus:outline-none",
          )}
        />
        <div className="flex items-center gap-1">
          {LOG_LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              className={cn(
                "px-2 py-0.5 text-xs rounded transition-colors",
                levelFilter.has(level)
                  ? level === "error"
                    ? "bg-red-500/20 text-red-400"
                    : level === "warn"
                      ? "bg-yellow-500/20 text-yellow-400"
                      : level === "debug"
                        ? "bg-muted text-muted-foreground"
                        : "bg-purple-500/20 text-purple-300"
                  : "bg-muted/20 text-muted-foreground/40",
              )}
            >
              {level}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded"
          />
          Auto-scroll
        </label>
        <button
          onClick={clear}
          className="px-2 py-0.5 text-xs rounded bg-muted/30 text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Log output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-black/20"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
          if (!atBottom && autoScroll) setAutoScroll(false);
        }}
      >
        {loading && lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading logs…
          </div>
        ) : filteredLines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No log entries
          </div>
        ) : (
          filteredLines.map((line, i) => <LogLine key={i} text={line} levelFilter={levelFilter} />)
        )}
      </div>
    </div>
  );
}
