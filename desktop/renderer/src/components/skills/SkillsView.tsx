import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import {
  type SkillInstallOption,
  type SkillOrigin,
  type SkillState,
  type SkillStatus,
  useSkillsStore,
} from "../../stores/skills-store";
import { AgentAllowlistEditor } from "./AgentAllowlistEditor";
import { IncomingPanel } from "./IncomingPanel";
import { SkillEditor } from "./SkillEditor";
import { TrustSettings } from "./TrustSettings";

type SkillMetrics = {
  skillKey: string;
  totalExecutions: number;
  successRate: number;
  avgRewardScore: number;
  avgExecutionTimeMs: number;
  userFeedbackScore: number;
  lastExecutedAt: number;
  errorBreakdown: Record<string, number>;
};

type RawSkillEntry = {
  skillKey?: string;
  name?: string;
  description?: string;
  source?: string;
  disabled?: boolean;
  eligible?: boolean;
  primaryEnv?: string;
  requirements?: { bins?: string[] };
  install?: SkillInstallOption[];
  state?: SkillState;
  reasons?: string[];
  platformLabel?: string;
  hasApiKey?: boolean;
  origin?: SkillOrigin;
};

type SkillReport = {
  skills?: RawSkillEntry[];
  [key: string]: unknown;
};

const VALID_STATES: ReadonlySet<SkillState> = new Set([
  "ready",
  "disabled-by-user",
  "missing-os",
  "missing-bin",
  "missing-env",
  "missing-config",
  "blocked-by-allowlist",
]);

function normalizeSkill(raw: RawSkillEntry): SkillStatus | null {
  const key = typeof raw.skillKey === "string" ? raw.skillKey : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!key) return null;
  const declaredState = raw.state && VALID_STATES.has(raw.state) ? raw.state : undefined;
  const fallbackState: SkillState =
    raw.disabled === true ? "disabled-by-user" : raw.eligible ? "ready" : "missing-bin";
  return {
    key,
    name: name || key,
    description: raw.description,
    category: raw.source,
    enabled: raw.disabled !== true,
    installed: raw.eligible === true,
    hasApiKey: raw.hasApiKey === true,
    state: declaredState ?? fallbackState,
    reasons: Array.isArray(raw.reasons) ? raw.reasons : [],
    platformLabel: raw.platformLabel,
    primaryEnv: raw.primaryEnv,
    requires: raw.requirements?.bins?.length ? { bins: raw.requirements.bins } : undefined,
    install: Array.isArray(raw.install) ? raw.install : undefined,
    origin: raw.origin,
  };
}

type StateAppearance = {
  label: string;
  className: string;
};

const STATE_APPEARANCE: Record<SkillState, StateAppearance> = {
  ready: { label: "Ready", className: "bg-green-500/10 text-green-300 border-green-500/20" },
  "disabled-by-user": {
    label: "Disabled",
    className: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
  },
  "missing-os": {
    label: "Incompatible OS",
    className: "bg-red-500/10 text-red-300 border-red-500/20",
  },
  "missing-bin": {
    label: "Needs install",
    className: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  },
  "missing-env": {
    label: "Needs API key",
    className: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  },
  "missing-config": {
    label: "Needs config",
    className: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  },
  "blocked-by-allowlist": {
    label: "Allowlisted off",
    className: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
  },
};

type FilterTab = "all" | "ready" | "disabled" | "needs-setup" | "incompatible";

const NEEDS_SETUP_STATES: ReadonlySet<SkillState> = new Set([
  "missing-bin",
  "missing-env",
  "missing-config",
]);

function matchesTab(skill: SkillStatus, tab: FilterTab): boolean {
  switch (tab) {
    case "all":
      return skill.state !== "missing-os";
    case "ready":
      return skill.state === "ready";
    case "disabled":
      return skill.state === "disabled-by-user" || skill.state === "blocked-by-allowlist";
    case "needs-setup":
      return NEEDS_SETUP_STATES.has(skill.state);
    case "incompatible":
      return skill.state === "missing-os";
  }
}

function StateBadge({ state, reasons }: { state: SkillState; reasons: string[] }) {
  const appearance = STATE_APPEARANCE[state];
  const tooltip = reasons.length > 0 ? reasons.join(" ") : appearance.label;
  return (
    <span
      title={tooltip}
      className={cn("text-xs px-1.5 py-0.5 rounded border", appearance.className)}
    >
      {appearance.label}
    </span>
  );
}

function MetricsLine({ metrics }: { metrics: SkillMetrics | undefined }) {
  if (!metrics || metrics.totalExecutions === 0) return null;
  const pct = Math.round(metrics.successRate * 100);
  const avgMs =
    metrics.avgExecutionTimeMs > 0 ? `${Math.round(metrics.avgExecutionTimeMs)}ms` : null;
  return (
    <div
      className="text-[10px] text-muted-foreground mt-1 flex flex-wrap gap-x-3"
      title={`Last run: ${new Date(metrics.lastExecutedAt).toLocaleString()}`}
    >
      <span>
        {metrics.totalExecutions} run{metrics.totalExecutions === 1 ? "" : "s"} ·{" "}
        <span
          className={cn(
            pct >= 80 ? "text-green-300" : pct >= 50 ? "text-amber-300" : "text-red-300",
          )}
        >
          {pct}% success
        </span>
      </span>
      {avgMs && <span>avg {avgMs}</span>}
      {metrics.userFeedbackScore !== 0 && (
        <span title="Aggregated user feedback score (-1..1)">
          fb {metrics.userFeedbackScore.toFixed(2)}
        </span>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  metrics,
  onToggle,
  onInstall,
  installing,
}: {
  skill: SkillStatus;
  metrics: SkillMetrics | undefined;
  onToggle: (key: string, enabled: boolean) => void;
  onInstall: (skill: SkillStatus) => void;
  installing: boolean;
}) {
  const isHardDisabled = skill.state === "missing-os" || skill.state === "blocked-by-allowlist";
  const showInstall = skill.state === "missing-bin" && (skill.install?.length ?? 0) > 0;
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-card/40 border border-border/10">
      <button
        onClick={() => !isHardDisabled && onToggle(skill.key, !skill.enabled)}
        disabled={isHardDisabled}
        title={
          isHardDisabled
            ? skill.reasons.join(" ") || "Cannot enable on this system"
            : skill.enabled
              ? "Disable"
              : "Enable"
        }
        className={cn(
          "mt-0.5 w-9 h-5 rounded-full transition-colors relative flex-shrink-0",
          skill.enabled && !isHardDisabled ? "bg-purple-500" : "bg-muted",
          isHardDisabled && "opacity-40 cursor-not-allowed",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
            skill.enabled && !isHardDisabled ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{skill.name}</span>
          <StateBadge state={skill.state} reasons={skill.reasons} />
          {skill.platformLabel && skill.state !== "missing-os" && (
            <span
              title={`Declared platform support: ${skill.platformLabel}`}
              className="text-xs px-1.5 py-0.5 rounded border bg-blue-500/10 text-blue-300 border-blue-500/20"
            >
              {skill.platformLabel}
            </span>
          )}
          {skill.hasApiKey && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
              API key set
            </span>
          )}
          {skill.category && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">
              {skill.category}
            </span>
          )}
        </div>
        {skill.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{skill.description}</p>
        )}
        {skill.requires?.bins && skill.requires.bins.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {skill.requires.bins.map((bin) => (
              <span
                key={bin}
                className="text-[10px] px-1 py-0.5 rounded bg-muted font-mono text-muted-foreground"
              >
                {bin}
              </span>
            ))}
          </div>
        )}
        {skill.origin?.registry && (
          <div className="text-[10px] text-muted-foreground mt-1 flex flex-wrap gap-x-2">
            <span title="Registry the skill was imported from">
              from <span className="text-foreground/80">{skill.origin.registry}</span>
            </span>
            {skill.origin.slug && <span>· slug {skill.origin.slug}</span>}
            {skill.origin.version && <span>· v{skill.origin.version}</span>}
            {skill.origin.license && <span>· {skill.origin.license}</span>}
            {skill.origin.upstreamUrl && (
              <a
                href={skill.origin.upstreamUrl}
                target="_blank"
                rel="noreferrer"
                className="text-purple-300 hover:underline"
              >
                upstream
              </a>
            )}
          </div>
        )}
        {showInstall && (
          <button
            onClick={() => onInstall(skill)}
            disabled={installing}
            className={cn(
              "mt-2 px-2 py-1 text-xs rounded-md border transition-colors",
              "bg-amber-500/10 text-amber-300 border-amber-500/20 hover:bg-amber-500/20",
              installing && "opacity-50 cursor-not-allowed",
            )}
          >
            {installing ? "Installing…" : (skill.install?.[0]?.label ?? "Install dependency")}
          </button>
        )}
        <MetricsLine metrics={metrics} />
      </div>
    </div>
  );
}

const TABS: Array<{ id: FilterTab; label: string }> = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "disabled", label: "Disabled" },
  { id: "needs-setup", label: "Needs setup" },
  { id: "incompatible", label: "Incompatible" },
];

type AgentRow = { id: string; identity?: { name?: string; emoji?: string } };
type AgentsListResult = { defaultId?: string; agents?: AgentRow[] };

type ViewMode = "installed" | "incoming";

export function SkillsView() {
  const [viewMode, setViewMode] = useState<ViewMode>("installed");
  const [incomingCount, setIncomingCount] = useState(0);
  const [showEditor, setShowEditor] = useState(false);
  const [showTrustSettings, setShowTrustSettings] = useState(false);
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const subscribe = useGatewayStore((s) => s.subscribe);

  const refreshIncomingCount = useCallback(async () => {
    if (gwStatus !== "connected") return;
    try {
      const res = (await request("skills.incoming.list", {})) as { skills?: unknown[] };
      setIncomingCount(Array.isArray(res?.skills) ? res.skills.length : 0);
    } catch {
      // non-fatal
    }
  }, [gwStatus, request]);

  useEffect(() => {
    refreshIncomingCount();
  }, [refreshIncomingCount]);

  useEffect(() => {
    return subscribe((evt) => {
      if (evt.event === "skills.changed") {
        void refreshIncomingCount();
      }
    });
  }, [subscribe, refreshIncomingCount]);

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Skills</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTrustSettings(true)}
            className="px-3 py-1.5 text-xs rounded-md border bg-card/50 text-muted-foreground border-border/30 hover:text-foreground transition-colors"
            title="Configure how skills enter your network"
          >
            Trust settings
          </button>
          <button
            onClick={() => setShowEditor(true)}
            className="px-3 py-1.5 text-xs rounded-md border bg-purple-500/10 text-purple-300 border-purple-500/20 hover:bg-purple-500/20 transition-colors"
          >
            + New skill
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-border/20 pb-2">
        <button
          onClick={() => setViewMode("installed")}
          className={cn(
            "px-3 py-1.5 text-sm rounded-md transition-colors",
            viewMode === "installed"
              ? "bg-purple-500/15 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Installed
        </button>
        <button
          onClick={() => setViewMode("incoming")}
          className={cn(
            "px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5",
            viewMode === "incoming"
              ? "bg-purple-500/15 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Incoming
          {incomingCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
              {incomingCount}
            </span>
          )}
        </button>
      </div>
      {viewMode === "installed" ? (
        <InstalledSkillsView />
      ) : (
        <IncomingPanel onCountChange={setIncomingCount} />
      )}
      {showEditor && <SkillEditor onClose={() => setShowEditor(false)} />}
      {showTrustSettings && <TrustSettings onClose={() => setShowTrustSettings(false)} />}
    </div>
  );
}

function InstalledSkillsView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const subscribe = useGatewayStore((s) => s.subscribe);
  const skills = useSkillsStore((s) => s.skills);
  const loading = useSkillsStore((s) => s.loading);
  const filter = useSkillsStore((s) => s.filter);
  const setSkills = useSkillsStore((s) => s.setSkills);
  const setLoading = useSkillsStore((s) => s.setLoading);
  const setError = useSkillsStore((s) => s.setError);
  const setFilter = useSkillsStore((s) => s.setFilter);
  const updateSkill = useSkillsStore((s) => s.updateSkill);

  const [tab, setTab] = useState<FilterTab>("all");
  const [installing, setInstalling] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [metricsByKey, setMetricsByKey] = useState<Record<string, SkillMetrics>>({});
  const [showAllowlistEditor, setShowAllowlistEditor] = useState(false);

  useEffect(() => {
    if (gwStatus !== "connected") return;
    void (async () => {
      try {
        const res = (await request("agents.list", {})) as AgentsListResult;
        const list = Array.isArray(res?.agents) ? res.agents : [];
        setAgents(list);
        if (!agentId && res?.defaultId) {
          setAgentId(res.defaultId);
        }
      } catch {
        // non-fatal: agent selector hides if list unavailable
      }
    })();
  }, [gwStatus, request, agentId]);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const params: Record<string, unknown> = {};
      if (agentId) params.agentId = agentId;
      const res = (await request("skills.status", params)) as SkillReport;
      if (Array.isArray(res?.skills)) {
        const normalized = res.skills
          .map(normalizeSkill)
          .filter((s): s is SkillStatus => s !== null);
        setSkills(normalized);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
    // Per-skill telemetry — best-effort; older gateways without
    // skills.metrics return an error and we just leave metrics empty.
    try {
      const m = (await request("skills.metrics", {})) as { metrics?: SkillMetrics[] };
      if (Array.isArray(m?.metrics)) {
        const map: Record<string, SkillMetrics> = {};
        for (const entry of m.metrics) {
          if (entry?.skillKey) map[entry.skillKey] = entry;
        }
        setMetricsByKey(map);
      }
    } catch {
      // non-fatal: metrics are decorative
    }
  }, [gwStatus, agentId, request, setSkills, setLoading, setError]);

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

  const handleToggle = useCallback(
    async (key: string, enabled: boolean) => {
      if (!key) {
        alert("Update failed: skill is missing an identifier");
        return;
      }
      try {
        await request("skills.update", { skillKey: key, enabled });
        updateSkill(key, { enabled });
      } catch (err) {
        alert(`Update failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, updateSkill],
  );

  const handleInstall = useCallback(
    async (skill: SkillStatus) => {
      const option = skill.install?.[0];
      if (!option) return;
      setInstalling(skill.key);
      try {
        await request("skills.install", { name: skill.name, installId: option.id });
      } catch (err) {
        alert(`Install failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setInstalling(null);
      }
    },
    [request],
  );

  const tabCounts = useMemo(() => {
    const counts: Record<FilterTab, number> = {
      all: 0,
      ready: 0,
      disabled: 0,
      "needs-setup": 0,
      incompatible: 0,
    };
    for (const skill of skills) {
      for (const t of TABS) {
        if (matchesTab(skill, t.id)) counts[t.id]++;
      }
    }
    return counts;
  }, [skills]);

  const filtered = useMemo(() => {
    let list = skills.filter((s) => matchesTab(s, tab));
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.key.toLowerCase().includes(q) ||
          s.category?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [skills, tab, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, SkillStatus[]>();
    for (const skill of filtered) {
      const cat = skill.category ?? "Other";
      const list = map.get(cat) ?? [];
      list.push(skill);
      map.set(cat, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const readyCount = skills.filter((s) => s.state === "ready").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {readyCount} ready of {skills.length} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          {agents.length > 1 && (
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className={cn(
                "h-8 px-2 text-xs rounded-lg border bg-transparent text-foreground",
                "border-border/30 focus:border-purple-500 focus:outline-none",
              )}
              title="View skills for this agent"
            >
              {agents.map((a) => {
                const label = a.identity?.name?.trim() || a.id;
                return (
                  <option key={a.id} value={a.id}>
                    {a.identity?.emoji ? `${a.identity.emoji} ` : ""}
                    {label}
                  </option>
                );
              })}
            </select>
          )}
          {agentId && (
            <button
              onClick={() => setShowAllowlistEditor(true)}
              className={cn(
                "px-3 py-1.5 text-xs rounded-lg",
                "bg-card/50 text-muted-foreground hover:text-foreground",
                "border border-border/30 transition-colors",
              )}
              title="Restrict which skills this agent can use"
            >
              Allowlist
            </button>
          )}
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
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border/20">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "px-3 py-1.5 text-xs rounded-t-md border-b-2 transition-colors",
                active
                  ? "border-purple-500 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <span className="ml-1.5 text-[10px] text-muted-foreground">{tabCounts[t.id]}</span>
            </button>
          );
        })}
      </div>

      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter skills…"
        className={cn(
          "w-full h-8 px-3 text-sm rounded-lg border bg-transparent",
          "border-border/30 focus:border-purple-500 focus:outline-none",
        )}
      />

      {groups.length === 0 && !loading ? (
        <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm">
          No skills match this view
        </div>
      ) : (
        groups.map(([category, categorySkills]) => (
          <div key={category} className="space-y-2">
            <h3 className="text-xs font-semibold text-[#00D4E6] uppercase tracking-wider px-1">
              {category}
            </h3>
            <div className="space-y-1">
              {categorySkills.map((skill) => (
                <SkillCard
                  key={skill.key}
                  skill={skill}
                  metrics={metricsByKey[skill.key]}
                  onToggle={handleToggle}
                  onInstall={handleInstall}
                  installing={installing === skill.key}
                />
              ))}
            </div>
          </div>
        ))
      )}

      {showAllowlistEditor && agentId && (
        <AgentAllowlistEditor
          agentId={agentId}
          agentLabel={agents.find((a) => a.id === agentId)?.identity?.name?.trim() || agentId}
          allSkills={skills}
          onClose={() => setShowAllowlistEditor(false)}
          onSaved={() => {
            setShowAllowlistEditor(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
