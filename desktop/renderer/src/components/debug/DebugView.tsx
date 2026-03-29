import { useCallback, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { cn } from "../../lib/utils";

function SnapshotViewer() {
  const hello = useGatewayStore((s) => s.hello);

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-border/10">
        <h3 className="text-sm font-medium text-foreground">
          Gateway Hello Snapshot
        </h3>
      </div>
      <pre className="p-4 text-xs font-mono text-foreground/80 whitespace-pre-wrap overflow-auto max-h-[400px]">
        {hello ? JSON.stringify(hello, null, 2) : "Not connected"}
      </pre>
    </div>
  );
}

function RpcCaller() {
  const request = useGatewayStore((s) => s.request);
  const gwStatus = useGatewayStore((s) => s.status);
  const [method, setMethod] = useState("health");
  const [params, setParams] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCall = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      let parsedParams: unknown;
      try {
        parsedParams = JSON.parse(params);
      } catch {
        setError("Invalid JSON params");
        setLoading(false);
        return;
      }
      const res = await request(method, parsedParams);
      setResult(JSON.stringify(res, null, 2));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : JSON.stringify(err, null, 2),
      );
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, method, params]);

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3">
      <h3 className="text-sm font-medium text-foreground">RPC Caller</h3>
      <div className="flex gap-2">
        <input
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          placeholder="Method name"
          className={cn(
            "h-8 px-3 text-sm font-mono rounded-lg border bg-transparent flex-1",
            "border-border/30 focus:border-purple-500 focus:outline-none",
          )}
        />
        <button
          onClick={handleCall}
          disabled={loading || gwStatus !== "connected"}
          className={cn(
            "px-4 py-1.5 text-xs rounded-lg font-medium",
            "bg-purple-500 text-white hover:bg-purple-600",
            "disabled:opacity-50 transition-colors",
          )}
        >
          {loading ? "Calling…" : "Call"}
        </button>
      </div>
      <textarea
        value={params}
        onChange={(e) => setParams(e.target.value)}
        placeholder='{"key": "value"}'
        rows={3}
        className={cn(
          "w-full px-3 py-2 text-xs font-mono rounded-lg border bg-transparent resize-none",
          "border-border/30 focus:border-purple-500 focus:outline-none",
        )}
        spellCheck={false}
      />
      {result && (
        <div className="rounded-lg border border-green-500/20 bg-green-500/5 overflow-hidden">
          <div className="px-3 py-1.5 text-xs text-green-400 border-b border-green-500/10">
            Response
          </div>
          <pre className="p-3 text-xs font-mono text-foreground/80 whitespace-pre-wrap overflow-auto max-h-[300px]">
            {result}
          </pre>
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 overflow-hidden">
          <div className="px-3 py-1.5 text-xs text-red-400 border-b border-red-500/10">
            Error
          </div>
          <pre className="p-3 text-xs font-mono text-red-300 whitespace-pre-wrap overflow-auto max-h-[300px]">
            {error}
          </pre>
        </div>
      )}
    </div>
  );
}

function HealthProbe() {
  const request = useGatewayStore((s) => s.request);
  const gwStatus = useGatewayStore((s) => s.status);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleProbe = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const res = await request("health", { probe: true });
      setResult(JSON.stringify(res, null, 2));
    } catch (err) {
      setResult(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request]);

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Health Probe</h3>
        <button
          onClick={handleProbe}
          disabled={loading || gwStatus !== "connected"}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg",
            "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
            "border border-purple-500/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Probing…" : "Run Probe"}
        </button>
      </div>
      {result && (
        <pre className="p-3 text-xs font-mono text-foreground/80 whitespace-pre-wrap overflow-auto max-h-[300px] rounded-lg bg-black/20">
          {result}
        </pre>
      )}
    </div>
  );
}

export function DebugView() {
  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Debug</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gateway inspection & RPC tools
        </p>
      </div>

      <RpcCaller />
      <HealthProbe />
      <SnapshotViewer />
    </div>
  );
}
