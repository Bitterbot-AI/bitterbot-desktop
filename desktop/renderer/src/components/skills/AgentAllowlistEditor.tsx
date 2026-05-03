import { useCallback, useEffect, useMemo, useState } from "react";
import type { SkillStatus } from "../../stores/skills-store";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

type Mode = "all" | "allowlist";

type AgentRecord = {
  id: string;
  skills?: string[];
};

type AgentsListPayload = {
  agents?: AgentRecord[];
};

export function AgentAllowlistEditor({
  agentId,
  agentLabel,
  allSkills,
  onClose,
  onSaved,
}: {
  agentId: string;
  agentLabel: string;
  allSkills: SkillStatus[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const request = useGatewayStore((s) => s.request);
  const [mode, setMode] = useState<Mode>("all");
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the existing allowlist from config (agents.list[id].skills).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = (await request("config.get", {})) as { config?: Record<string, unknown> };
        const agentsRaw = (cfg?.config as { agents?: unknown })?.agents;
        const list = (agentsRaw as { list?: AgentRecord[] })?.list ?? [];
        const entry = list.find((a) => a?.id === agentId);
        if (cancelled) return;
        if (entry?.skills && Array.isArray(entry.skills)) {
          setMode("allowlist");
          setAllowed(new Set(entry.skills));
        } else {
          setMode("all");
          setAllowed(new Set());
        }
        setHydrated(true);
      } catch {
        // If config.get is unavailable, fall back to "view" the current
        // skills list and let the user opt in to allowlist mode.
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, request]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return allSkills;
    const q = filter.toLowerCase();
    return allSkills.filter(
      (s) =>
        s.key.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false),
    );
  }, [allSkills, filter]);

  const toggle = useCallback((key: string) => {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setAll = useCallback(() => {
    setAllowed(new Set(allSkills.map((s) => s.key)));
  }, [allSkills]);

  const setNone = useCallback(() => {
    setAllowed(new Set());
  }, []);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const skillsParam: string[] | null = mode === "all" ? null : [...allowed];
      await request("skills.updateAgentFilter", { agentId, skills: skillsParam });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [agentId, allowed, mode, onSaved, request]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-border/30 bg-card shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Skill allowlist</h2>
            <p className="text-xs text-muted-foreground">
              Restrict which skills <span className="text-foreground">{agentLabel}</span> can use.
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

        <div className="px-5 py-3 border-b border-border/10 space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMode("all")}
              className={cn(
                "flex-1 px-3 py-2 text-xs rounded-md border transition-colors text-left",
                mode === "all"
                  ? "bg-purple-500/15 border-purple-500/30 text-foreground"
                  : "border-border/30 text-muted-foreground hover:text-foreground",
              )}
            >
              <div className="font-medium">All skills</div>
              <div className="text-[10px] opacity-80">No restriction (default)</div>
            </button>
            <button
              onClick={() => setMode("allowlist")}
              className={cn(
                "flex-1 px-3 py-2 text-xs rounded-md border transition-colors text-left",
                mode === "allowlist"
                  ? "bg-purple-500/15 border-purple-500/30 text-foreground"
                  : "border-border/30 text-muted-foreground hover:text-foreground",
              )}
            >
              <div className="font-medium">Custom allowlist</div>
              <div className="text-[10px] opacity-80">
                {mode === "allowlist" ? `${allowed.size} selected` : "Pick specific skills"}
              </div>
            </button>
          </div>
        </div>

        {mode === "allowlist" && (
          <div className="px-5 py-2 flex items-center gap-2 border-b border-border/10">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter skills…"
              className={cn(
                "flex-1 h-8 px-3 text-xs rounded-md border bg-transparent",
                "border-border/30 focus:border-purple-500 focus:outline-none",
              )}
            />
            <button
              onClick={setAll}
              className="px-2 py-1 text-[11px] rounded border border-border/30 hover:text-foreground text-muted-foreground"
            >
              Select all
            </button>
            <button
              onClick={setNone}
              className="px-2 py-1 text-[11px] rounded border border-border/30 hover:text-foreground text-muted-foreground"
            >
              Clear
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {!hydrated ? (
            <div className="p-4 text-xs text-muted-foreground text-center">Loading…</div>
          ) : mode === "all" ? (
            <p className="text-xs text-muted-foreground">
              All installed skills are available to this agent. Switch to Custom allowlist above to
              restrict.
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground">No skills match this filter.</p>
          ) : (
            <ul className="space-y-1">
              {filtered.map((s) => {
                const checked = allowed.has(s.key);
                return (
                  <li key={s.key}>
                    <label
                      className={cn(
                        "flex items-start gap-2 px-3 py-2 rounded-md border cursor-pointer",
                        "border-border/10 bg-card/40 hover:border-border/30",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(s.key)}
                        className="mt-0.5"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="text-sm text-foreground">{s.name}</span>
                        {s.description && (
                          <span className="block text-[11px] text-muted-foreground line-clamp-1">
                            {s.description}
                          </span>
                        )}
                        <span className="block text-[10px] font-mono text-muted-foreground/70">
                          {s.key}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
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
            disabled={busy}
            className={cn(
              "px-3 py-1.5 text-xs rounded-md border transition-colors",
              "bg-purple-500/15 text-purple-200 border-purple-500/30 hover:bg-purple-500/25",
              busy && "opacity-50 cursor-not-allowed",
            )}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
