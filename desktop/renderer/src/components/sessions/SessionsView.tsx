import { useCallback, useEffect, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { useSessionsStore, type SessionEntry } from "../../stores/sessions-store";
import { formatRelativeTime, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";

function SessionRow({
  session,
  onPatch,
  onDelete,
  onReset,
}: {
  session: SessionEntry;
  onPatch: (key: string, patch: Record<string, unknown>) => void;
  onDelete: (key: string) => void;
  onReset: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/10 last:border-0">
      <div
        className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {session.label ?? session.key}
            </span>
            {session.label && (
              <span className="text-xs text-muted-foreground/60 font-mono truncate">
                {session.key}
              </span>
            )}
          </div>
        </div>
        {session.model && (
          <span className="text-xs px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 whitespace-nowrap">
            {session.model}
          </span>
        )}
        {typeof session.totalTokens === "number" && session.totalTokens > 0 && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {formatTokens(session.totalTokens)} tokens
          </span>
        )}
        {session.updatedAt && (
          <span className="text-xs text-muted-foreground/60 whitespace-nowrap">
            {formatRelativeTime(session.updatedAt)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {session.sessionId && (
              <div>
                <span className="text-muted-foreground">Session ID: </span>
                <span className="text-foreground font-mono">
                  {session.sessionId}
                </span>
              </div>
            )}
            {session.thinkingLevel && (
              <div>
                <span className="text-muted-foreground">Thinking: </span>
                <span className="text-foreground">{session.thinkingLevel}</span>
              </div>
            )}
            {session.channel && (
              <div>
                <span className="text-muted-foreground">Channel: </span>
                <span className="text-foreground">{session.channel}</span>
              </div>
            )}
            {session.modelProvider && (
              <div>
                <span className="text-muted-foreground">Provider: </span>
                <span className="text-foreground">{session.modelProvider}</span>
              </div>
            )}
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                const level = prompt(
                  "Thinking level (none, low, medium, high):",
                  session.thinkingLevel ?? "medium",
                );
                if (level) onPatch(session.key, { thinkingLevel: level });
              }}
              className="px-2 py-1 text-xs rounded bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 border border-purple-500/20"
            >
              Set Thinking
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Reset session "${session.key}"?`)) onReset(session.key);
              }}
              className="px-2 py-1 text-xs rounded bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 border border-yellow-500/20"
            >
              Reset
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete session "${session.key}"? This cannot be undone.`))
                  onDelete(session.key);
              }}
              className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionsView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const sessions = useSessionsStore((s) => s.sessions);
  const loading = useSessionsStore((s) => s.loading);
  const filter = useSessionsStore((s) => s.filter);
  const setSessions = useSessionsStore((s) => s.setSessions);
  const setLoading = useSessionsStore((s) => s.setLoading);
  const setError = useSessionsStore((s) => s.setError);
  const setFilter = useSessionsStore((s) => s.setFilter);
  const removeSession = useSessionsStore((s) => s.removeSession);
  const updateSession = useSessionsStore((s) => s.updateSession);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const res = (await request("sessions.list", {})) as {
        sessions?: SessionEntry[];
      };
      if (res?.sessions) {
        setSessions(res.sessions);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setSessions, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handlePatch = useCallback(
    async (key: string, patch: Record<string, unknown>) => {
      try {
        await request("sessions.patch", { key, ...patch });
        updateSession(key, patch as Partial<SessionEntry>);
      } catch (err) {
        alert(`Patch failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, updateSession],
  );

  const handleDelete = useCallback(
    async (key: string) => {
      try {
        await request("sessions.delete", { key });
        removeSession(key);
      } catch (err) {
        alert(`Delete failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, removeSession],
  );

  const handleReset = useCallback(
    async (key: string) => {
      try {
        await request("sessions.reset", { key });
        refresh();
      } catch (err) {
        alert(`Reset failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, refresh],
  );

  const filtered = filter
    ? sessions.filter(
        (s) =>
          s.key.toLowerCase().includes(filter.toLowerCase()) ||
          s.label?.toLowerCase().includes(filter.toLowerCase()),
      )
    : sessions;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sessions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg",
            "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
            "border border-purple-500/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter sessions…"
        className={cn(
          "w-full h-8 px-3 text-sm rounded-lg border bg-transparent",
          "border-border/30 focus:border-purple-500 focus:outline-none",
        )}
      />

      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            {loading ? "Loading sessions…" : "No sessions found"}
          </div>
        ) : (
          filtered.map((session) => (
            <SessionRow
              key={session.key}
              session={session}
              onPatch={handlePatch}
              onDelete={handleDelete}
              onReset={handleReset}
            />
          ))
        )}
      </div>
    </div>
  );
}
