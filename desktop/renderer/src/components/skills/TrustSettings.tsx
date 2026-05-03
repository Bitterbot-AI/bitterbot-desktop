import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

type IngestPolicy = "auto" | "review" | "deny";
type ScannerMode = "regex" | "off";
type DefaultTrust = "auto" | "review";

type P2pSettings = {
  ingestPolicy: IngestPolicy;
  maxIngestedPerHour: number;
  injectionScanner: ScannerMode;
  quarantineTtlDays: number;
};

type AgentskillsSettings = {
  enabled: boolean;
  defaultTrust: DefaultTrust;
};

const DEFAULTS: { p2p: P2pSettings; agentskills: AgentskillsSettings } = {
  p2p: {
    ingestPolicy: "deny",
    maxIngestedPerHour: 20,
    injectionScanner: "regex",
    quarantineTtlDays: 30,
  },
  agentskills: {
    enabled: false,
    defaultTrust: "review",
  },
};

export function TrustSettings({ onClose }: { onClose: () => void }) {
  const request = useGatewayStore((s) => s.request);
  const [p2p, setP2p] = useState<P2pSettings>(DEFAULTS.p2p);
  const [agentskills, setAgentskills] = useState<AgentskillsSettings>(DEFAULTS.agentskills);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = (await request("config.get", {})) as { config?: Record<string, unknown> };
        const skillsCfg = (res?.config as { skills?: unknown })?.skills as
          | {
              p2p?: Partial<P2pSettings>;
              agentskills?: Partial<AgentskillsSettings>;
            }
          | undefined;
        if (cancelled) return;
        if (skillsCfg?.p2p) {
          setP2p({
            ingestPolicy: (skillsCfg.p2p.ingestPolicy as IngestPolicy) ?? DEFAULTS.p2p.ingestPolicy,
            maxIngestedPerHour: skillsCfg.p2p.maxIngestedPerHour ?? DEFAULTS.p2p.maxIngestedPerHour,
            injectionScanner:
              (skillsCfg.p2p.injectionScanner as ScannerMode) ?? DEFAULTS.p2p.injectionScanner,
            quarantineTtlDays: skillsCfg.p2p.quarantineTtlDays ?? DEFAULTS.p2p.quarantineTtlDays,
          });
        }
        if (skillsCfg?.agentskills) {
          setAgentskills({
            enabled: skillsCfg.agentskills.enabled ?? DEFAULTS.agentskills.enabled,
            defaultTrust:
              (skillsCfg.agentskills.defaultTrust as DefaultTrust) ??
              DEFAULTS.agentskills.defaultTrust,
          });
        }
      } catch {
        // Use defaults if config.get unavailable.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await request("skills.updateTrustSettings", { p2p, agentskills });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [agentskills, onClose, p2p, request]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-xl border border-border/30 bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Skill trust settings</h2>
            <p className="text-xs text-muted-foreground">
              Controls how skills enter your network from peers and registries.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!hydrated ? (
            <div className="p-4 text-xs text-muted-foreground text-center">Loading…</div>
          ) : (
            <>
              <section className="space-y-3">
                <h3 className="text-xs font-semibold text-[#00D4E6] uppercase tracking-wider">
                  P2P ingest
                </h3>
                <Row label="Ingest policy" hint="What happens to skills received from peers.">
                  <select
                    value={p2p.ingestPolicy}
                    onChange={(e) =>
                      setP2p({ ...p2p, ingestPolicy: e.target.value as IngestPolicy })
                    }
                    disabled={busy}
                    className={selectCls}
                  >
                    <option value="deny">deny — drop everything (default)</option>
                    <option value="review">review — quarantine, manual accept</option>
                    <option value="auto">auto — accept signed skills from trusted peers</option>
                  </select>
                </Row>
                <Row label="Max ingested per hour" hint="Rate limit on inbound skills.">
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={p2p.maxIngestedPerHour}
                    onChange={(e) =>
                      setP2p({ ...p2p, maxIngestedPerHour: Number(e.target.value) || 1 })
                    }
                    disabled={busy}
                    className={inputCls}
                  />
                </Row>
                <Row label="Injection scanner" hint="Regex scan for prompt-injection patterns.">
                  <select
                    value={p2p.injectionScanner}
                    onChange={(e) =>
                      setP2p({ ...p2p, injectionScanner: e.target.value as ScannerMode })
                    }
                    disabled={busy}
                    className={selectCls}
                  >
                    <option value="regex">regex (default)</option>
                    <option value="off">off (transport crypto only)</option>
                  </select>
                </Row>
                <Row
                  label="Quarantine TTL (days)"
                  hint="Auto-reject quarantined skills after this many days. 0 = forever."
                >
                  <input
                    type="number"
                    min={0}
                    max={3650}
                    value={p2p.quarantineTtlDays}
                    onChange={(e) =>
                      setP2p({ ...p2p, quarantineTtlDays: Number(e.target.value) || 0 })
                    }
                    disabled={busy}
                    className={inputCls}
                  />
                </Row>
              </section>

              <section className="space-y-3">
                <h3 className="text-xs font-semibold text-[#00D4E6] uppercase tracking-wider">
                  agentskills.io bridge
                </h3>
                <Row
                  label="Enabled"
                  hint="Allow importing skills from agentskills.io by slug or URL."
                >
                  <label className="inline-flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={agentskills.enabled}
                      onChange={(e) =>
                        setAgentskills({ ...agentskills, enabled: e.target.checked })
                      }
                      disabled={busy}
                    />
                    {agentskills.enabled ? "enabled" : "disabled"}
                  </label>
                </Row>
                <Row label="Default trust" hint="What an imported skill defaults to.">
                  <select
                    value={agentskills.defaultTrust}
                    onChange={(e) =>
                      setAgentskills({
                        ...agentskills,
                        defaultTrust: e.target.value as DefaultTrust,
                      })
                    }
                    disabled={busy || !agentskills.enabled}
                    className={selectCls}
                  >
                    <option value="review">review (default)</option>
                    <option value="auto">auto</option>
                  </select>
                </Row>
              </section>
            </>
          )}
        </div>

        {error && (
          <div className="px-5 py-2 text-xs text-red-300 border-t border-border/10">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/20">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md border border-border/30 text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !hydrated}
            className={cn(
              "px-3 py-1.5 text-xs rounded-md border transition-colors",
              "bg-purple-500/15 text-purple-200 border-purple-500/30 hover:bg-purple-500/25",
              (busy || !hydrated) && "opacity-50 cursor-not-allowed",
            )}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const selectCls = cn(
  "h-8 px-2 text-xs rounded-md border bg-transparent text-foreground",
  "border-border/30 focus:border-purple-500 focus:outline-none",
);
const inputCls = cn(
  "h-8 w-32 px-2 text-xs rounded-md border bg-transparent text-foreground",
  "border-border/30 focus:border-purple-500 focus:outline-none",
);

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-foreground">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
