import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

type IncomingSkill = {
  name: string;
  author_peer_id?: string;
  timestamp?: number;
  description?: string;
  category?: string;
  tags?: string[];
  signatureValid?: boolean;
  injectionScan?: { severity?: string; matches?: number };
  provenance?: Record<string, unknown>;
  contentHash?: string;
  expiresAt?: number;
};

type IncomingListResult = { skills?: IncomingSkill[] };

function formatTimestamp(ts?: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function shortPeer(peer?: string): string {
  if (!peer) return "unknown peer";
  if (peer.length <= 16) return peer;
  return `${peer.slice(0, 8)}…${peer.slice(-6)}`;
}

function severityClass(severity?: string): string {
  if (severity === "critical") return "bg-red-500/15 text-red-300 border-red-500/30";
  if (severity === "high") return "bg-orange-500/15 text-orange-300 border-orange-500/30";
  if (severity === "medium") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (severity === "low") return "bg-yellow-500/10 text-yellow-300 border-yellow-500/20";
  return "bg-zinc-500/10 text-zinc-300 border-zinc-500/20";
}

function ImportFromAgentskills() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const submit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = (await request("skills.import.agentskills", { input: trimmed })) as {
        ok: boolean;
        action?: string;
        skillName?: string;
        reason?: string;
      };
      if (res.ok) {
        setInput("");
        setMessage({
          kind: "ok",
          text:
            res.action === "accepted"
              ? `Imported "${res.skillName}" — installed and ready to enable.`
              : `Imported "${res.skillName}" — queued for review below.`,
        });
      } else {
        setMessage({ kind: "err", text: res.reason ?? "Import failed" });
      }
    } catch (err) {
      setMessage({
        kind: "err",
        text: err instanceof Error ? err.message : "Import failed",
      });
    } finally {
      setBusy(false);
    }
  }, [input, request]);

  return (
    <div className="p-4 rounded-lg border border-border/20 bg-card/40 space-y-2">
      <div className="text-sm font-semibold text-foreground">Import from agentskills.io</div>
      <p className="text-xs text-muted-foreground">
        Paste a skill slug (e.g. <code className="text-foreground">brave-search</code>) or full
        https URL. By default imports go through the review queue.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="slug or https URL"
          disabled={busy || gwStatus !== "connected"}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submit();
            }
          }}
          className={cn(
            "flex-1 h-8 px-3 text-sm rounded-md border bg-transparent text-foreground",
            "border-border/30 focus:border-purple-500 focus:outline-none",
            busy && "opacity-50",
          )}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !input.trim() || gwStatus !== "connected"}
          className={cn(
            "px-3 py-1.5 text-xs rounded-md border transition-colors",
            "bg-purple-500/10 text-purple-300 border-purple-500/20 hover:bg-purple-500/20",
            (busy || !input.trim()) && "opacity-50 cursor-not-allowed",
          )}
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
      {message && (
        <div className={cn("text-xs", message.kind === "ok" ? "text-green-300" : "text-red-300")}>
          {message.text}
        </div>
      )}
    </div>
  );
}

export function IncomingPanel({
  onCountChange,
}: {
  onCountChange?: (count: number) => void;
} = {}) {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const subscribe = useGatewayStore((s) => s.subscribe);

  const [items, setItems] = useState<IncomingSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onCountChange?.(items.length);
  }, [items.length, onCountChange]);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const res = (await request("skills.incoming.list", {})) as IncomingListResult;
      setItems(Array.isArray(res?.skills) ? res.skills : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load incoming skills");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribe((evt) => {
      if (evt.event === "skills.changed") {
        void refresh();
      }
    });
  }, [subscribe, refresh]);

  const accept = useCallback(
    async (name: string) => {
      if (
        !confirm(
          `Accept "${name}" into managed skills?\n\nThis copies it from quarantine. It will be installed but stay disabled until you toggle it on.`,
        )
      )
        return;
      setBusy(name);
      try {
        await request("skills.incoming.accept", { skillName: name });
      } catch (err) {
        alert(`Accept failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setBusy(null);
      }
    },
    [request],
  );

  const reject = useCallback(
    async (name: string) => {
      if (!confirm(`Reject "${name}" and remove from quarantine?`)) return;
      setBusy(name);
      try {
        await request("skills.incoming.reject", { skillName: name });
      } catch (err) {
        alert(`Reject failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setBusy(null);
      }
    },
    [request],
  );

  const rejectByPeer = useCallback(
    async (peer: string) => {
      if (
        !confirm(
          `Reject every quarantined skill from peer ${shortPeer(peer)}?\n\nThis cannot be undone.`,
        )
      )
        return;
      setBusy(`peer:${peer}`);
      try {
        await request("skills.incoming.rejectByPeer", { authorPeerId: peer });
      } catch (err) {
        alert(`Bulk reject failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setBusy(null);
      }
    },
    [request],
  );

  return (
    <div className="space-y-4">
      <ImportFromAgentskills />
      {error && (
        <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-sm">
          {error}
        </div>
      )}
      {loading && items.length === 0 && (
        <div className="p-8 text-center text-muted-foreground text-sm">
          Loading incoming skills…
        </div>
      )}
      {!loading && items.length === 0 && !error && (
        <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm">
          No skills in quarantine. New marketplace skills appear here for review.
        </div>
      )}
      {items.map((item) => {
        const itemBusy = busy === item.name;
        const peer = item.author_peer_id;
        const peerBusy = peer ? busy === `peer:${peer}` : false;
        const sigOk = item.signatureValid === true;
        const sigBad = item.signatureValid === false;
        const scanSeverity = item.injectionScan?.severity;
        return (
          <div
            key={item.name}
            className="p-4 rounded-lg border border-border/20 bg-card/40 space-y-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{item.name}</span>
              {item.category && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">
                  {item.category}
                </span>
              )}
              {sigOk && (
                <span className="text-xs px-1.5 py-0.5 rounded border bg-green-500/10 text-green-300 border-green-500/20">
                  signature ok
                </span>
              )}
              {sigBad && (
                <span className="text-xs px-1.5 py-0.5 rounded border bg-red-500/10 text-red-300 border-red-500/20">
                  signature failed
                </span>
              )}
              {scanSeverity && (
                <span
                  title={`Injection scan: ${scanSeverity}${
                    item.injectionScan?.matches ? ` (${item.injectionScan.matches} matches)` : ""
                  }`}
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded border",
                    severityClass(scanSeverity),
                  )}
                >
                  scan: {scanSeverity}
                </span>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground">{item.description}</p>
            )}
            <div className="text-[11px] text-muted-foreground space-y-0.5 font-mono">
              <div>From: {shortPeer(peer)}</div>
              <div>Received: {formatTimestamp(item.timestamp)}</div>
              {item.contentHash && (
                <div title={item.contentHash}>Hash: {item.contentHash.slice(0, 16)}…</div>
              )}
              {item.expiresAt && <div>Expires: {formatTimestamp(item.expiresAt)}</div>}
            </div>
            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => accept(item.name)}
                disabled={itemBusy}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-md border transition-colors",
                  "bg-green-500/10 text-green-300 border-green-500/20 hover:bg-green-500/20",
                  itemBusy && "opacity-50 cursor-not-allowed",
                )}
              >
                {itemBusy ? "Working…" : "Accept"}
              </button>
              <button
                onClick={() => reject(item.name)}
                disabled={itemBusy}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-md border transition-colors",
                  "bg-red-500/10 text-red-300 border-red-500/20 hover:bg-red-500/20",
                  itemBusy && "opacity-50 cursor-not-allowed",
                )}
              >
                Reject
              </button>
              {peer && (
                <button
                  onClick={() => rejectByPeer(peer)}
                  disabled={peerBusy}
                  title={`Reject all queued skills from ${shortPeer(peer)}`}
                  className={cn(
                    "px-3 py-1.5 text-xs rounded-md border transition-colors",
                    "bg-zinc-500/10 text-zinc-300 border-zinc-500/20 hover:bg-zinc-500/20",
                    peerBusy && "opacity-50 cursor-not-allowed",
                  )}
                >
                  Reject all from peer
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
