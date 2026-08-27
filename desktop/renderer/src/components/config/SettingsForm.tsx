/**
 * PLAN-41 Phase 2 (p0-15): the curated Settings form.
 *
 * Renders every config path the gateway publishes a uiHint for (label/help
 * from `config.schema`), grouped by top-level section, with a search box,
 * restart-required chips derived from the gateway's own reload rules, and
 * saves via `config.patch` (JSON merge-patch of only the dirty keys).
 * Adjudicated D-D rides on this: every default-flipped flag has a hint, so
 * every one of them is a toggle here — no more hand-edited dotted keys.
 */
import { RotateCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { ConfigSchema, ConfigSnapshot } from "../../stores/config-store";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

type ReloadRule = { prefix: string; kind: "restart" | "hot" | "none" };
type UiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};

function getAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Build a nested object from dotted-path entries, for config.patch. */
export function buildPatchObject(dirty: Map<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of dirty) {
    const parts = path.split(".");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof cur[key] !== "object" || cur[key] === null) {
        cur[key] = {};
      }
      cur = cur[key] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }
  return root;
}

/** First matching prefix rule decides; no match = restart (mirrors the gateway). */
export function reloadKindForPath(path: string, rules: ReloadRule[]): ReloadRule["kind"] {
  for (const rule of rules) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      return rule.kind;
    }
  }
  return "restart";
}

/** A path the form can edit inline: primitive value (or unset boolean-ish). */
function isEditablePath(path: string, value: unknown): boolean {
  if (path.includes("*") || path.includes("[]")) {
    return false;
  }
  if (value === undefined || value === null) {
    // Only synthesize controls for unset flags we can render honestly.
    return /\.(enabled|checkOnStart)$/.test(path);
  }
  const t = typeof value;
  return t === "boolean" || t === "string" || t === "number";
}

export function SettingsForm({
  snapshot,
  schema,
  saving,
  onPatch,
}: {
  snapshot: ConfigSnapshot;
  schema: ConfigSchema | null;
  saving: boolean;
  onPatch: (patch: Record<string, unknown>, needsRestart: boolean) => Promise<boolean>;
}) {
  const request = useGatewayStore((s) => s.request);
  const config = (snapshot.config ?? {}) as Record<string, unknown>;
  const hints = (schema?.uiHints ?? {}) as Record<string, UiHint>;
  const reloadRules = ((schema as { reloadRules?: ReloadRule[] } | null)?.reloadRules ??
    []) as ReloadRule[];

  const [search, setSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dirty, setDirty] = useState<Map<string, unknown>>(new Map());
  const [restartPending, setRestartPending] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const sections = useMemo(() => {
    const leaf = Object.entries(hints).filter(([path, hint]) => {
      if (!path.includes(".")) {
        return false; // group headers
      }
      if (hint.advanced && !showAdvanced) {
        return false;
      }
      if (!isEditablePath(path, getAtPath(config, path))) {
        return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${path} ${hint.label ?? ""} ${hint.help ?? ""}`.toLowerCase();
        if (!hay.includes(q)) {
          return false;
        }
      }
      return true;
    });
    const byGroup = new Map<string, Array<[string, UiHint]>>();
    for (const entry of leaf) {
      const seg = entry[0].split(".")[0];
      const list = byGroup.get(seg) ?? [];
      list.push(entry);
      byGroup.set(seg, list);
    }
    return Array.from(byGroup.entries())
      .map(([seg, entries]) => ({
        seg,
        title: hints[seg]?.label ?? seg,
        order: hints[seg]?.order ?? 999,
        entries: entries.toSorted((a, b) => a[0].localeCompare(b[0])),
      }))
      .toSorted((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }, [hints, config, search, showAdvanced]);

  const effective = (path: string): unknown =>
    dirty.has(path) ? dirty.get(path) : getAtPath(config, path);

  const setValue = (path: string, value: unknown) => {
    const next = new Map(dirty);
    const original = getAtPath(config, path);
    if (Object.is(value, original)) {
      next.delete(path);
    } else {
      next.set(path, value);
    }
    setDirty(next);
  };

  const dirtyNeedsRestart = Array.from(dirty.keys()).some(
    (path) => reloadKindForPath(path, reloadRules) === "restart",
  );

  const handleSave = async () => {
    if (dirty.size === 0) {
      return;
    }
    const ok = await onPatch(buildPatchObject(dirty), dirtyNeedsRestart);
    if (ok) {
      if (dirtyNeedsRestart) {
        setRestartPending(true);
      }
      setDirty(new Map());
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await request("system.restart", {});
    } catch {
      /* the socket drops on restart — expected */
    }
  };

  return (
    <div className="space-y-4" data-testid="settings-form">
      {/* Sticky restart banner */}
      {restartPending && (
        <div className="sticky top-0 z-10 flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
          <span className="flex-1">Saved. Some changes need a gateway restart to take effect.</span>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 transition-colors disabled:opacity-50"
          >
            <RotateCw className={cn("w-3.5 h-3.5", restarting && "animate-spin")} />
            {restarting ? "Restarting…" : "Restart now"}
          </button>
          <button
            onClick={() => setRestartPending(false)}
            className="text-amber-300/60 hover:text-amber-300"
          >
            Later
          </button>
        </div>
      )}

      {/* Toolbar: search + advanced + save */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings…"
            className="pl-8 h-8 text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <Switch checked={showAdvanced} onCheckedChange={setShowAdvanced} />
          Show advanced
        </label>
        <div className="flex-1" />
        {dirty.size > 0 && (
          <span className="text-xs text-muted-foreground">
            {dirty.size} unsaved change{dirty.size === 1 ? "" : "s"}
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={saving || dirty.size === 0}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg font-medium transition-colors",
            "bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-40",
          )}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {sections.length === 0 && (
        <div className="p-6 text-sm text-muted-foreground text-center">
          No settings match “{search}”.
        </div>
      )}

      {sections.map((section) => (
        <div
          key={section.seg}
          className="rounded-lg border border-border/10 bg-muted/20 overflow-hidden"
        >
          <div className="px-3 py-2 bg-muted/30 border-b border-border/10">
            <span className="text-xs font-semibold text-foreground">{section.title}</span>
          </div>
          <div className="divide-y divide-border/5">
            {section.entries.map(([path, hint]) => {
              const value = effective(path);
              const kind = reloadKindForPath(path, reloadRules);
              const isDirty = dirty.has(path);
              const isBool =
                typeof value === "boolean" ||
                (value === undefined && /\.(enabled|checkOnStart)$/.test(path));
              return (
                <div key={path} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn("text-sm", isDirty && "text-purple-300")}>
                        {hint.label ?? path}
                      </span>
                      {kind === "restart" && (
                        <span
                          title="Applying this change restarts the gateway"
                          className="px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide bg-amber-500/10 text-amber-400 border border-amber-500/20"
                        >
                          restart
                        </span>
                      )}
                    </div>
                    {hint.help && (
                      <p className="text-xs text-muted-foreground mt-0.5">{hint.help}</p>
                    )}
                    <p className="text-2xs font-mono text-muted-foreground/50 mt-0.5">{path}</p>
                  </div>
                  <div className="flex-shrink-0">
                    {isBool ? (
                      <Switch
                        checked={value === true}
                        onCheckedChange={(checked) => setValue(path, checked)}
                        aria-label={hint.label ?? path}
                      />
                    ) : (
                      <Input
                        type={
                          hint.sensitive
                            ? "password"
                            : typeof value === "number"
                              ? "number"
                              : "text"
                        }
                        defaultValue={
                          typeof value === "string" && value.startsWith("***") ? "" : String(value)
                        }
                        placeholder={
                          typeof value === "string" && value.startsWith("***")
                            ? "•••••• (set)"
                            : hint.placeholder
                        }
                        onChange={(e) => {
                          const raw = e.target.value;
                          setValue(path, typeof value === "number" ? Number(raw) : raw);
                        }}
                        className="h-7 w-56 text-xs font-mono"
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
