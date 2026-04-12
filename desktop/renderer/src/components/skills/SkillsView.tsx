import { useCallback, useEffect } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useSkillsStore, type SkillStatus } from "../../stores/skills-store";

type SkillReport = {
  skills?: Array<{
    key: string;
    name: string;
    description?: string;
    category?: string;
    enabled: boolean;
    installed: boolean;
    hasApiKey?: boolean;
    requires?: { bins?: string[] };
    metadata?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
};

function SkillCard({
  skill,
  onToggle,
}: {
  skill: SkillStatus;
  onToggle: (key: string, enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-card/40 border border-border/10">
      <button
        onClick={() => onToggle(skill.key, !skill.enabled)}
        className={cn(
          "mt-0.5 w-9 h-5 rounded-full transition-colors relative flex-shrink-0",
          skill.enabled ? "bg-purple-500" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
            skill.enabled ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{skill.name}</span>
          {skill.category && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300">
              {skill.category}
            </span>
          )}
          {!skill.installed && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400">
              not installed
            </span>
          )}
          {skill.hasApiKey && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
              API key set
            </span>
          )}
        </div>
        {skill.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{skill.description}</p>
        )}
        {skill.requires?.bins && skill.requires.bins.length > 0 && (
          <div className="flex gap-1 mt-1">
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
      </div>
    </div>
  );
}

export function SkillsView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const skills = useSkillsStore((s) => s.skills);
  const loading = useSkillsStore((s) => s.loading);
  const filter = useSkillsStore((s) => s.filter);
  const setSkills = useSkillsStore((s) => s.setSkills);
  const setLoading = useSkillsStore((s) => s.setLoading);
  const setError = useSkillsStore((s) => s.setError);
  const setFilter = useSkillsStore((s) => s.setFilter);
  const updateSkill = useSkillsStore((s) => s.updateSkill);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const res = (await request("skills.status", {})) as SkillReport;
      if (res?.skills) {
        setSkills(res.skills);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setSkills, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (key: string, enabled: boolean) => {
      try {
        await request("skills.update", { skillKey: key, enabled });
        updateSkill(key, { enabled });
      } catch (err) {
        alert(`Update failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, updateSkill],
  );

  const filtered = filter
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(filter.toLowerCase()) ||
          s.key.toLowerCase().includes(filter.toLowerCase()) ||
          s.category?.toLowerCase().includes(filter.toLowerCase()),
      )
    : skills;

  // Group by category
  const groups = new Map<string, SkillStatus[]>();
  for (const skill of filtered) {
    const cat = skill.category ?? "Other";
    const list = groups.get(cat) ?? [];
    list.push(skill);
    groups.set(cat, list);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Skills</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {skills.filter((s) => s.enabled).length} enabled of {skills.length}
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

      {sortedGroups.length === 0 && !loading ? (
        <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm">
          No skills found
        </div>
      ) : (
        sortedGroups.map(([category, categorySkills]) => (
          <div key={category} className="space-y-2">
            <h3 className="text-xs font-semibold text-[#00D4E6] uppercase tracking-wider px-1">
              {category}
            </h3>
            <div className="space-y-1">
              {categorySkills.map((skill) => (
                <SkillCard key={skill.key} skill={skill} onToggle={handleToggle} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
