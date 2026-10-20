import { useCallback, useEffect, useState } from "react";
import { formatCost } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useModelsStore } from "../../stores/models-store";
import { useUsageStore, type UsageWhatIf as WhatIfResult } from "../../stores/usage-store";
import { formatPct, pricingSourceLabel, pricingSourceTone } from "./usage-format";

/** "What if another model had handled this window?" Re-prices the same tokens; nothing is called. */
export function UsageWhatIf() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const days = useUsageStore((s) => s.days);
  const catalog = useModelsStore((s) => s.catalog);
  const loadCatalog = useModelsStore((s) => s.loadCatalog);
  const [target, setTarget] = useState<string>("");
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "connected" && catalog.length === 0) {
      void loadCatalog();
    }
  }, [status, catalog.length, loadCatalog]);

  const run = useCallback(async () => {
    const slash = target.indexOf("/");
    if (slash <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await request("usage.ledger.whatif", {
        days,
        provider: target.slice(0, slash),
        model: target.slice(slash + 1),
      })) as WhatIfResult;
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "What-if failed");
    } finally {
      setLoading(false);
    }
  }, [target, days, request]);

  const options = catalog.filter((m) => m.allowed !== false);

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-medium text-foreground">
          What if another model had handled this window?
        </h3>
        <span className="text-2xs text-muted-foreground">same tokens, that model's prices</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          id="usage-whatif-model"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="rounded-lg border border-border/20 bg-background px-2 py-1 text-xs text-foreground"
        >
          <option value="">Choose a model…</option>
          {options.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.provider}/{m.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void run()}
          disabled={!target || loading}
          className={cn(
            "px-3 py-1 text-xs rounded-lg bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20 transition-colors",
            (!target || loading) && "opacity-50",
          )}
        >
          {loading ? "Replaying…" : "Replay"}
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {result && (
        <div className="space-y-2">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-xl font-semibold text-foreground tabular-nums">
              {formatCost(result.projectedCost)}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              instead of {formatCost(result.actualCost)}
            </span>
            <span
              className={cn(
                "text-xs tabular-nums",
                result.savingsUsd >= 0 ? "text-success" : "text-warning",
              )}
            >
              {result.savingsUsd >= 0 ? "save" : "spend"} {formatCost(Math.abs(result.savingsUsd))}{" "}
              ({formatPct(Math.abs(result.savingsPct))})
            </span>
            <span
              className={cn(
                "rounded border px-1.5 text-2xs",
                pricingSourceTone(result.target.source),
              )}
            >
              {pricingSourceLabel(result.target.source)}
            </span>
          </div>
          <div className="text-2xs text-muted-foreground space-y-0.5">
            {result.byModel.slice(0, 6).map((m) => (
              <div
                key={`${m.provider}/${m.model}`}
                className="flex justify-between gap-3 tabular-nums"
              >
                <span className="truncate">
                  {m.provider}/{m.model} · {m.calls} calls
                </span>
                <span>
                  {formatCost(m.actualCost)} → {formatCost(m.projectedCost)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-2xs text-muted-foreground/60">{result.caveat}</p>
        </div>
      )}
    </div>
  );
}
