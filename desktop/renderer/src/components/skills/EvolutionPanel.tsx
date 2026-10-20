/**
 * PLAN-45 Phase 6: the skill-evolution card. Everything shown comes from
 * `skills.evolution.status` (the gateway's collector) and the per-skill
 * evidence records housekeeping rebuilt; nothing is recomputed here, so
 * this panel, the CLI (`bitterbot skills evidence`) and the published
 * evidence agree.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

type Ladder =
  | "staged"
  | "validated"
  | "canary"
  | "stable"
  | "rolled-back"
  | "retired"
  | "canary-off"
  | "unmanaged";

export type EvidenceRecord = {
  name: string;
  origin: string;
  ladder: Ladder;
  ladderAt: number | null;
  canary: { startedAt: number; endedAt: number | null; reason: string } | null;
  modelDrift: { from: string; to: string; at: number } | null;
  reads: {
    total: number;
    runs: number;
    pass: number;
    fail: number;
    successRate: number | null;
    lastReadAt: number | null;
  };
  gate: {
    verdict: string | null;
    mode: string | null;
    pValue: number | null;
    wins: number | null;
    losses: number | null;
    trials: number | null;
    validatedAt: number | null;
  } | null;
  models: { validatedOn: string[]; readBy: string[] };
  publishedAt: number | null;
};

export type EvolutionStatusResult = {
  config?: {
    enabled: boolean;
    cadenceHours: number;
    validationMode: string;
    validationModeEffective: string;
    validationModeSource?: string;
    capabilityTasks: number;
    pendingDrafts: number;
    maxActiveEvolved: number;
  };
  recentIterations?: Array<{ at: number; ran: boolean; reason: string | null }>;
  pendingPeer?: Array<{ name: string; gateAttempts: number; lastVerdict: string | null }>;
  evolvedLive?: Array<{ name: string }>;
  failureSignatures?: Array<{ key: string; count: number; iterations: number }>;
  evidence?: EvidenceRecord[];
};

export function ladderTone(ladder: Ladder): string {
  switch (ladder) {
    case "stable":
      return "bg-success/15 text-success";
    case "canary":
    case "validated":
    case "staged":
      return "bg-warning/15 text-warning";
    case "rolled-back":
    case "retired":
    case "canary-off":
      return "bg-destructive/15 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return "never";
  const h = Math.floor(Math.max(0, now - ts) / 3_600_000);
  if (h < 1) return `${Math.floor(Math.max(0, now - ts) / 60_000)}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pct(v: number | null): string {
  return v === null ? "n/a" : `${Math.round(v * 100)}%`;
}

export function EvolutionPanel() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [status, setStatus] = useState<EvolutionStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await request("skills.evolution.status", {})) as EvolutionStatusResult;
      setStatus(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    if (gwStatus === "connected") void load();
  }, [gwStatus, load]);

  if (gwStatus !== "connected") {
    return (
      <p className="text-sm text-muted-foreground">
        Connect to the gateway to see skill evolution.
      </p>
    );
  }
  if (error) {
    return (
      <div className="text-sm text-destructive" role="alert">
        Could not load evolution status: {error}
      </div>
    );
  }
  if (!status) {
    return <p className="text-sm text-muted-foreground">Loading evolution status…</p>;
  }

  const cfg = status.config;
  const managed = (status.evidence ?? []).filter((r) => r.ladder !== "unmanaged");
  const lastIteration = status.recentIterations?.[status.recentIterations.length - 1] ?? null;
  const tasksReachable = cfg ? cfg.validationModeEffective === "tasks" : false;

  return (
    <div className="flex flex-col gap-4" data-testid="evolution-panel">
      <section className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Evolution loop</h3>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-muted-foreground">Enabled</dt>
          <dd>{cfg ? (cfg.enabled ? `yes, every ${cfg.cadenceHours}h` : "no") : "unknown"}</dd>
          <dt className="text-muted-foreground">Validation</dt>
          <dd>
            {cfg ? (
              <span className={cn(tasksReachable ? "text-success" : "text-warning")}>
                {cfg.validationModeEffective} mode, {cfg.capabilityTasks} capability tasks
                {cfg.validationMode !== cfg.validationModeEffective
                  ? ` (configured ${cfg.validationMode})`
                  : ""}
              </span>
            ) : (
              "unknown"
            )}
          </dd>
          <dt className="text-muted-foreground">Last iteration</dt>
          <dd>
            {lastIteration
              ? `${formatAgo(lastIteration.at)}${lastIteration.ran ? "" : ` (skipped: ${lastIteration.reason ?? "no reason"})`}`
              : "none yet"}
          </dd>
          <dt className="text-muted-foreground">Live</dt>
          <dd>
            {managed.length} managed
            {cfg ? ` of ${cfg.maxActiveEvolved} max` : ""}
            {status.pendingPeer && status.pendingPeer.length > 0
              ? `, ${status.pendingPeer.length} peer pending gate`
              : ""}
            {cfg && cfg.pendingDrafts > 0 ? `, ${cfg.pendingDrafts} corpus drafts to review` : ""}
          </dd>
        </dl>
        {status.failureSignatures && status.failureSignatures.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Recurring gaps:{" "}
            {status.failureSignatures
              .slice(0, 3)
              .map((f) => `${f.key} (${f.count} in ${f.iterations} iterations)`)
              .join("; ")}
          </p>
        )}
      </section>

      {managed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No evolved or received skill is live yet. A skill appears here once it passes the
          validation gate; its evidence record is rebuilt by housekeeping.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {managed.map((r) => (
            <li
              key={r.name}
              className="rounded-lg border border-border p-4"
              data-testid={`evidence-${r.name}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-badge", ladderTone(r.ladder))}>
                  {r.ladder}
                </span>
                <span className="text-xs text-muted-foreground">{r.origin}</span>
                {r.modelDrift && (
                  <span className="text-xs text-warning">
                    model drift {r.modelDrift.from} → {r.modelDrift.to}
                  </span>
                )}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                <dt className="text-muted-foreground">Gate</dt>
                <dd className="sm:col-span-2">
                  {r.gate?.verdict
                    ? `${r.gate.verdict} (${r.gate.mode ?? "?"}${r.gate.pValue !== null ? `, p=${r.gate.pValue.toFixed(3)}` : ""}${r.gate.wins !== null ? `, ${r.gate.wins}W/${r.gate.losses ?? 0}L over ${r.gate.trials ?? "?"} trials` : ""})`
                    : "none"}
                </dd>
                <dt className="text-muted-foreground">Canary</dt>
                <dd className="sm:col-span-2">
                  {r.canary
                    ? `${r.canary.endedAt ? "ended" : "running"}, started ${formatAgo(r.canary.startedAt)} (${r.canary.reason})`
                    : "none"}
                </dd>
                <dt className="text-muted-foreground">Production reads</dt>
                <dd className="sm:col-span-2">
                  {r.reads.total} in {r.reads.runs} runs, {pct(r.reads.successRate)} success (
                  {r.reads.pass} pass / {r.reads.fail} fail), last {formatAgo(r.reads.lastReadAt)}
                </dd>
                <dt className="text-muted-foreground">Models</dt>
                <dd className="sm:col-span-2">
                  validated on {r.models.validatedOn.join(", ") || "n/a"}; read by{" "}
                  {r.models.readBy.join(", ") || "none"}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
