import { useCallback, useEffect } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useNodesStore, type NodeEntry, type PairRequest } from "../../stores/nodes-store";

function NodeCard({ node }: { node: NodeEntry }) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "w-2 h-2 rounded-full mt-1.5 flex-shrink-0",
            node.connected ? "bg-green-400" : "bg-muted-foreground/30",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {node.displayName ?? node.nodeId}
            </span>
            {node.connected && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
                connected
              </span>
            )}
            {node.paired && !node.connected && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                paired (offline)
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
            {node.platform && <span>Platform: {node.platform}</span>}
            {node.version && <span>Version: {node.version}</span>}
            {node.deviceFamily && <span>Device: {node.deviceFamily}</span>}
            {node.remoteIp && <span className="font-mono">IP: {node.remoteIp}</span>}
            {node.connectedAtMs && <span>Connected: {formatRelativeTime(node.connectedAtMs)}</span>}
          </div>
          {node.commands.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {node.commands.slice(0, 10).map((cmd) => (
                <span
                  key={cmd}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 font-mono"
                >
                  {cmd}
                </span>
              ))}
              {node.commands.length > 10 && (
                <span className="text-[10px] text-muted-foreground">
                  +{node.commands.length - 10} more
                </span>
              )}
            </div>
          )}
          {node.caps.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {node.caps.map((cap) => (
                <span
                  key={cap}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono"
                >
                  {cap}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PairRequestCard({
  req,
  onApprove,
  onReject,
}: {
  req: PairRequest;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
}) {
  return (
    <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 backdrop-blur-sm p-4">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-foreground">
            {req.displayName ?? req.nodeId}
          </span>
          {req.platform && (
            <span className="ml-2 text-xs text-muted-foreground">({req.platform})</span>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Requesting to pair • {formatRelativeTime(req.ts)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onApprove(req.requestId)}
            className="px-3 py-1.5 text-xs rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20"
          >
            Approve
          </button>
          <button
            onClick={() => onReject(req.requestId)}
            className="px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export function NodesView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const nodes = useNodesStore((s) => s.nodes);
  const pairRequests = useNodesStore((s) => s.pairRequests);
  const loading = useNodesStore((s) => s.loading);
  const setNodes = useNodesStore((s) => s.setNodes);
  const setPairRequests = useNodesStore((s) => s.setPairRequests);
  const setLoading = useNodesStore((s) => s.setLoading);
  const setError = useNodesStore((s) => s.setError);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const [nodeRes, pairRes] = await Promise.all([
        request("node.list", {}),
        request("node.pair.list", {}),
      ]);
      const nr = nodeRes as { nodes?: NodeEntry[] };
      const pr = pairRes as { requests?: PairRequest[]; pending?: PairRequest[] };
      if (nr?.nodes) setNodes(nr.nodes);
      if (pr?.requests || pr?.pending) setPairRequests(pr.requests ?? pr.pending ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load nodes");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setNodes, setPairRequests, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for pair request events
  useGatewayEvent(
    "node.pair.requested",
    useCallback(() => refresh(), [refresh]),
  );
  useGatewayEvent(
    "node.pair.resolved",
    useCallback(() => refresh(), [refresh]),
  );

  const handleApprove = useCallback(
    async (requestId: string) => {
      try {
        await request("node.pair.approve", { requestId });
        refresh();
      } catch (err) {
        alert(`Approve failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, refresh],
  );

  const handleReject = useCallback(
    async (requestId: string) => {
      try {
        await request("node.pair.reject", { requestId });
        refresh();
      } catch (err) {
        alert(`Reject failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, refresh],
  );

  const connectedCount = nodes.filter((n) => n.connected).length;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Nodes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {connectedCount} connected, {nodes.length} total
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

      {/* Pending pair requests */}
      {pairRequests.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-yellow-400 uppercase tracking-wider px-1">
            Pending Pair Requests
          </h3>
          {pairRequests.map((req) => (
            <PairRequestCard
              key={req.requestId}
              req={req}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </div>
      )}

      {/* Node list */}
      <div className="space-y-3">
        {nodes.length === 0 && !loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm">
            No nodes paired or connected
          </div>
        ) : (
          nodes.map((node) => <NodeCard key={node.nodeId} node={node} />)
        )}
      </div>
    </div>
  );
}
