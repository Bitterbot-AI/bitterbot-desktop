/**
 * PLAN-41 Phase 2 (sota-bar rec 1, scoped): doctor-fed Repairs card. Shows
 * warn/error findings from the gateway's doctor.findings RPC, grouped by
 * section, with severity chips. The full HA-style issue registry (fix
 * flows, ignore persistence) is deliberately post-V1.
 */
import { RefreshCw, ShieldAlert, Wrench } from "lucide-react";
import { useCallback, useEffect } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { repairsAttention, useRepairsStore, type RepairFinding } from "../../stores/repairs-store";

export function RepairsCard() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const findings = useRepairsStore((s) => s.findings);
  const loading = useRepairsStore((s) => s.loading);
  const setFindings = useRepairsStore((s) => s.setFindings);
  const setLoading = useRepairsStore((s) => s.setLoading);

  const refresh = useCallback(async () => {
    if (status !== "connected") return;
    setLoading(true);
    try {
      const res = await request<{ findings?: RepairFinding[]; checkedAt?: number }>(
        "doctor.findings",
        {},
      );
      setFindings(res.findings ?? [], res.checkedAt ?? Date.now());
    } catch {
      /* older gateway without the RPC: card just shows nothing */
    } finally {
      setLoading(false);
    }
  }, [status, request, setFindings, setLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const actionable = findings.filter((f) => f.level === "warn" || f.level === "error");
  if (actionable.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="repairs-card"
      className="rounded-xl border border-warning/20 bg-warning/5 p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Wrench className="w-4 h-4 text-warning" />
          Repairs
          <span className="px-1.5 py-0.5 rounded-full text-2xs bg-warning/15 text-warning">
            {repairsAttention(findings)}
          </span>
        </h2>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          title="Re-run checks"
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
        </button>
      </div>
      <div className="space-y-2">
        {actionable.map((f, i) => (
          <div key={`${f.section}-${i}`} className="flex items-start gap-2">
            <ShieldAlert
              className={cn(
                "w-3.5 h-3.5 mt-0.5 flex-shrink-0",
                f.level === "error" ? "text-danger" : "text-warning",
              )}
            />
            <div className="min-w-0">
              <span
                className={cn(
                  "mr-2 px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide",
                  f.level === "error" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning",
                )}
              >
                {f.section}
              </span>
              <span className="text-xs text-foreground whitespace-pre-wrap break-words">
                {f.message}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
