import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useConfirm } from "../ui/confirm-dialog";

type IncomingOrigin = "peer" | "external-scrape" | "local-dream" | "incomplete";

type IncomingSkill = {
  name: string;
  origin?: IncomingOrigin;
  author_peer_id?: string;
  timestamp?: number;
  description?: string;
  category?: string;
  tags?: string[];
  signatureValid?: boolean;
  injectionScan?: { severity?: string; matches?: number };
  /** PLAN-44 Phase 5b: whether the agent could route to this skill by its description. */
  routing?: { hold: boolean; summary: string };
  provenance?: Record<string, unknown>;
  contentHash?: string;
  expiresAt?: number;
};

/** Honest source line — only genuine peer skills are "received from" a peer. */
function sourceLine(item: IncomingSkill): string {
  switch (item.origin) {
    case "external-scrape":
      return "Harvested locally (this node)";
    case "local-dream":
      return "Generated locally (dream engine)";
    case "incomplete":
      return "Incomplete download";
    case "peer":
      return `Received from ${shortPeer(item.author_peer_id)}`;
    default:
      // Older gateway with no origin field: fall back to prior behavior but
      // don't assert a peer we can't name.
      return item.author_peer_id
        ? `Received from ${shortPeer(item.author_peer_id)}`
        : "Local (this node)";
  }
}

const ORIGIN_BADGE: Record<IncomingOrigin, { label: string; cls: string } | null> = {
  peer: { label: "from peer", cls: "bg-info/10 text-info border-info/20" },
  "external-scrape": { label: "local harvest", cls: "bg-muted text-muted-foreground" },
  "local-dream": { label: "local · dream", cls: "bg-brand/10 text-brand" },
  incomplete: { label: "incomplete", cls: "bg-warning/10 text-warning border-warning/20" },
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
  if (severity === "critical") return "bg-danger/15 text-danger border-danger/30";
  if (severity === "high") return "bg-warning/15 text-warning border-warning/30";
  if (severity === "medium") return "bg-warning/15 text-warning border-warning/30";
  if (severity === "low") return "bg-warning/10 text-warning border-warning/20";
  return "bg-muted/10 text-foreground border-border/20";
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
            "border-border/30 focus:border-brand focus:outline-none",
            busy && "opacity-50",
          )}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !input.trim() || gwStatus !== "connected"}
          className={cn(
            "px-3 py-1.5 text-xs rounded-md border transition-colors",
            "bg-brand/10 text-brand border-brand/20 hover:bg-brand/30",
            (busy || !input.trim()) && "opacity-50 cursor-not-allowed",
          )}
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
      {message && (
        <div className={cn("text-xs", message.kind === "ok" ? "text-success" : "text-danger")}>
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
  const [confirmDialog, confirmElement] = useConfirm();
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
        !(await confirmDialog({
          title: `Accept "${name}" into managed skills?`,
          description:
            "This copies it from quarantine. It will be installed but stay disabled until you toggle it on.",
          actionLabel: "Accept",
        }))
      )
        return;
      setBusy(name);
      try {
        await request("skills.incoming.accept", { skillName: name });
      } catch (err) {
        toast.error("Accept failed", {
          description: describeError(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [request, confirmDialog],
  );

  const reject = useCallback(
    async (name: string) => {
      if (
        !(await confirmDialog({
          title: `Reject "${name}" and remove from quarantine?`,
          actionLabel: "Reject",
          destructive: true,
        }))
      )
        return;
      setBusy(name);
      try {
        await request("skills.incoming.reject", { skillName: name });
      } catch (err) {
        toast.error("Reject failed", {
          description: describeError(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [request, confirmDialog],
  );

  const rejectByPeer = useCallback(
    async (peer: string) => {
      if (
        !(await confirmDialog({
          title: `Reject every quarantined skill from peer ${shortPeer(peer)}?`,
          description: "This cannot be undone.",
          actionLabel: "Reject all",
          destructive: true,
        }))
      )
        return;
      setBusy(`peer:${peer}`);
      try {
        await request("skills.incoming.rejectByPeer", { authorPeerId: peer });
      } catch (err) {
        toast.error("Bulk reject failed", {
          description: describeError(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [request, confirmDialog],
  );

  return (
    <div className="space-y-4">
      <ImportFromAgentskills />
      {error && (
        <div className="p-4 rounded-lg border border-danger/30 bg-danger/10 text-danger text-sm">
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
              {item.origin && ORIGIN_BADGE[item.origin] && (
                <span
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded border",
                    ORIGIN_BADGE[item.origin]!.cls,
                  )}
                >
                  {ORIGIN_BADGE[item.origin]!.label}
                </span>
              )}
              {item.category && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-brand/10 text-brand">
                  {item.category}
                </span>
              )}
              {sigOk && (
                <span className="text-xs px-1.5 py-0.5 rounded border bg-success/10 text-success border-success/20">
                  signature ok
                </span>
              )}
              {sigBad && (
                <span className="text-xs px-1.5 py-0.5 rounded border bg-danger/10 text-danger border-danger/20">
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
              {item.routing?.summary && (
                <span
                  title={item.routing.summary}
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded border",
                    item.routing.hold
                      ? "bg-warning/15 text-warning border-warning/30"
                      : "bg-muted/30 text-muted-foreground border-border/30",
                  )}
                >
                  {item.routing.hold ? "held: won't route" : "routing note"}
                </span>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground">{item.description}</p>
            )}
            <div className="text-2xs text-muted-foreground space-y-0.5 font-mono">
              <div>{sourceLine(item)}</div>
              <div>Added: {formatTimestamp(item.timestamp)}</div>
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
                    className="text-badge px-1 py-0.5 rounded bg-muted text-muted-foreground"
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
                  "bg-success/10 text-success border-success/20 hover:bg-success/30",
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
                  "bg-danger/10 text-danger border-danger/20 hover:bg-danger/30",
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
                    "bg-muted/10 text-foreground border-border/20 hover:bg-muted/30",
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
      {confirmElement}
    </div>
  );
}
