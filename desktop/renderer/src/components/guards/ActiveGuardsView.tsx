/**
 * PLAN-20 Phase 4: Active Guards view.
 *
 * Lists every active pre-action interceptor with its fire counts, outcome
 * distribution, and a live feed of recent activations. Listens to the
 * "intervention.fired" websocket events emitted from the gateway when an
 * interceptor activates.
 *
 * This is the user-facing surface where the biological agent's
 * deterministic competence layer becomes legible.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { InterventionEventCard, type InterventionFiredEvent } from "./InterventionEventCard";

interface InterceptorSummary {
  skill: string;
  interceptorId: string;
  fireCount: number;
  successCount: number;
  failureCount: number;
  userConfirmedCount: number;
  userOverrideCount: number;
  avgLatencyMs: number;
  firstSeenTs: number;
  lastSeenTs: number;
}

interface StrikeRow {
  interceptorId: string;
  strikes: number;
  disabled: boolean;
  lastFailureTs: number | null;
  lastFailureReason: string | null;
}

interface HarvestCandidate {
  skill: string;
  skillMdPath: string;
  stagedAtMs: number | null;
  body: string;
}

interface GuardsStatusPayload {
  ok: boolean;
  registered: Array<{
    id: string;
    skill: string;
    origin: string;
    priority: number;
  }>;
  stats: InterceptorSummary[];
  recent: Array<InterventionFiredEvent & { id: string }>;
  strikes?: StrikeRow[];
  candidates?: HarvestCandidate[];
}

const MAX_LIVE_EVENTS = 30;

function valueScore(s: InterceptorSummary): number {
  const denom = s.successCount + s.failureCount;
  if (denom === 0) return 0;
  return s.successCount / denom;
}

function valueLabel(score: number, fires: number): { label: string; tone: string } {
  if (fires === 0) return { label: "no data yet", tone: "text-muted-foreground/60" };
  if (score >= 0.8) return { label: "strong", tone: "text-emerald-400" };
  if (score >= 0.5) return { label: "useful", tone: "text-amber-300" };
  return { label: "weak", tone: "text-red-400" };
}

export function ActiveGuardsView() {
  const [status, setStatus] = useState<GuardsStatusPayload | null>(null);
  const [liveFeed, setLiveFeed] = useState<InterventionFiredEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useGatewayStore((s) => s.request);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request<GuardsStatusPayload>("guards.status", {});
      if (res?.ok) {
        setStatus(res);
      } else {
        setError("Gateway did not return guard status. Restart the gateway to enable it.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        msg.includes("unknown method") ? "Gateway needs a restart to expose guard status." : msg,
      );
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFired = useCallback((payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as InterventionFiredEvent;
    setLiveFeed((prev) => [evt, ...prev].slice(0, MAX_LIVE_EVENTS));
  }, []);

  useGatewayEvent("intervention.fired", onFired);

  const statsBySkill = useMemo(() => {
    const map = new Map<string, InterceptorSummary[]>();
    for (const s of status?.stats ?? []) {
      const list = map.get(s.skill) ?? [];
      list.push(s);
      map.set(s.skill, list);
    }
    return map;
  }, [status]);

  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-4">
        <div>
          <h1 className="text-xl font-semibold">Active Guards</h1>
          <p className="text-sm text-muted-foreground">
            Safety rules that run before your agent acts — deterministic checks on tool use,
            independent of model judgment.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className={cn(
            "ml-auto px-3 py-1.5 text-xs rounded-lg",
            "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
            "border border-purple-500/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-200 text-xs">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[#00D4E6]">
          Registered Interceptors ({status?.registered.length ?? 0})
        </h2>
        {(!status || status.registered.length === 0) && !loading && (
          <div className="p-4 rounded-lg border border-border/20 bg-card/60 text-sm text-muted-foreground">
            No safety rules registered yet. Restart the gateway to pick up the built-in set.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[...statsBySkill.entries()].map(([skill, summaries]) => {
            const totalFires = summaries.reduce((s, x) => s + x.fireCount, 0);
            const totalSuccess = summaries.reduce((s, x) => s + x.successCount, 0);
            const totalFailure = summaries.reduce((s, x) => s + x.failureCount, 0);
            const score =
              totalFires === 0 ? 0 : totalSuccess / Math.max(1, totalSuccess + totalFailure);
            const vl = valueLabel(score, totalFires);
            return (
              <div
                key={skill}
                className="rounded-xl border border-border/30 bg-card/70 backdrop-blur-sm p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <div className="font-medium">{skill}</div>
                  <span className={cn("text-badge ml-auto", vl.tone)}>{vl.label}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <Stat label="fires" value={totalFires} />
                  <Stat label="success" value={totalSuccess} tone="text-emerald-400" />
                  <Stat label="failure" value={totalFailure} tone="text-red-400" />
                </div>
                <div className="text-badge text-muted-foreground space-y-0.5">
                  {summaries.map((s) => (
                    <div key={s.interceptorId} className="flex items-center gap-2 font-mono">
                      <span>{s.interceptorId}</span>
                      <span className="ml-auto tabular-nums">
                        {s.avgLatencyMs ? `${s.avgLatencyMs.toFixed(1)}ms` : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {status &&
            status.registered
              .filter((r) => !statsBySkill.has(r.skill))
              .map((r) => (
                <div
                  key={r.id}
                  className="rounded-xl border border-border/20 bg-card/40 p-3 space-y-1 opacity-70"
                >
                  <div className="font-medium">{r.skill}</div>
                  <div className="text-badge text-muted-foreground font-mono">{r.id}</div>
                  <div className="text-badge text-muted-foreground">
                    registered · no activations yet
                  </div>
                </div>
              ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[#00D4E6]">
          Live Feed ({liveFeed.length})
        </h2>
        {liveFeed.length === 0 ? (
          <div className="p-4 rounded-lg border border-border/20 bg-card/40 text-sm text-muted-foreground">
            No activations yet this session. Send the agent a message and the live feed will
            populate.
          </div>
        ) : (
          <div className="space-y-2">
            {liveFeed.map((evt, i) => (
              <InterventionEventCard key={`${evt.ts}-${i}`} event={evt} />
            ))}
          </div>
        )}
      </section>

      {status?.candidates && status.candidates.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[#00D4E6]">
            Dream-Harvested Candidates ({status.candidates.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Bitterbot proposed these interceptors during a recent dream cycle from observed
            competence gaps. Promoting copies the SKILL.md into <code>~/.bitterbot/skills/</code>; a
            TypeScript implementation must be added under{" "}
            <code>src/agents/skills/builtin-interceptors/</code> before the interceptor becomes
            live.
          </p>
          <div className="space-y-3">
            {status.candidates.map((c) => (
              <CandidateCard
                key={c.skill}
                candidate={c}
                onPromote={async () => {
                  try {
                    await request<{ ok: boolean }>("guards.promote_candidate", { skill: c.skill });
                    await refresh();
                  } catch (err) {
                    setError(String(err));
                  }
                }}
              />
            ))}
          </div>
        </section>
      )}

      {status?.strikes && status.strikes.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[#00D4E6]">
            Auto-Disable Strikes ({status.strikes.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Interceptors that have thrown during evaluation. After 3 strikes they auto-disable until
            cleared.
          </p>
          <div className="space-y-2">
            {status.strikes.map((s) => (
              <div
                key={s.interceptorId}
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs space-y-1",
                  s.disabled
                    ? "border-red-500/40 bg-red-500/10"
                    : "border-amber-500/40 bg-amber-500/10",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-foreground">{s.interceptorId}</span>
                  <span className="ml-auto tabular-nums">
                    {s.strikes} {s.strikes === 1 ? "strike" : "strikes"}
                  </span>
                  {s.disabled && (
                    <span className="text-badge uppercase tracking-wider text-red-300">
                      disabled
                    </span>
                  )}
                </div>
                {s.lastFailureReason && (
                  <div className="text-muted-foreground/80 font-mono text-badge">
                    {s.lastFailureReason}
                  </div>
                )}
                <button
                  onClick={async () => {
                    try {
                      await request<{ ok: boolean }>("guards.clear_strikes", {
                        interceptorId: s.interceptorId,
                      });
                      await refresh();
                    } catch (err) {
                      setError(String(err));
                    }
                  }}
                  className={cn(
                    "px-2 py-1 text-badge rounded-md border",
                    "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
                    "border-purple-500/30",
                  )}
                >
                  Clear strikes & re-enable
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[#00D4E6]">
          Recent Persisted Records ({status?.recent.length ?? 0})
        </h2>
        <div className="space-y-2">
          {(status?.recent ?? []).map((rec) => (
            <InterventionEventCard key={rec.id} event={rec} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CandidateCard({
  candidate,
  onPromote,
}: {
  candidate: HarvestCandidate;
  onPromote: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const stagedAt = candidate.stagedAtMs
    ? new Date(candidate.stagedAtMs).toLocaleString()
    : "recently";
  // Render the first ~25 lines of the SKILL.md as a preview.
  const preview = candidate.body.split("\n").slice(0, 25).join("\n");
  return (
    <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="font-semibold">{candidate.skill}</div>
        <span className="text-badge uppercase tracking-wider text-purple-300 ml-auto">
          staged {stagedAt}
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words text-2xs text-muted-foreground font-mono leading-tight">
        {expanded ? candidate.body : preview}
        {!expanded && candidate.body.split("\n").length > 25 ? "\n…" : ""}
      </pre>
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-2 py-1 text-2xs rounded-md border bg-card border-border/30 hover:bg-muted"
        >
          {expanded ? "Hide" : "Show full SKILL.md"}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onPromote();
            } finally {
              setBusy(false);
            }
          }}
          className={cn(
            "ml-auto px-3 py-1.5 text-xs rounded-md",
            "bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25",
            "border border-cyan-400/30",
            busy && "opacity-50",
          )}
        >
          {busy ? "Promoting…" : "Promote to skills/"}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-badge uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular-nums text-sm", tone)}>{value}</span>
    </div>
  );
}
