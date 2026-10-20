/**
 * PLAN-41 Phase 2 (p0-15): the curated Settings form.
 * PLAN-56 Phase 1: settings that tell the truth.
 *
 * Renders every config path the gateway publishes a uiHint for (label/help
 * from `config.schema`), grouped by top-level section, with a search box,
 * restart-required chips derived from the gateway's own reload rules, and
 * saves via `config.patch` (JSON merge-patch of only the dirty keys).
 *
 * What a row shows is the EFFECTIVE value: the unsaved edit, else the value in
 * the config file (`snapshot.config`, which carries the gateway's load-time
 * defaults), else `hint.default` (the point-of-use default the gateway
 * catalogues in src/config/schema.defaults.ts). A row whose value comes from
 * the default wears a "default" badge. Control types come from the JSON
 * schema (switch / select / number / text); `meta.*` is read-only; deprecated
 * keys are never offered and show read-only (with the reason) only while the
 * file still sets them; "Add setting" exposes every labelled key that is unset
 * and has no default, and an added row stays clean until the user acts on it.
 */
import { Plus, RotateCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import type { ConfigSchema, ConfigSnapshot } from "../../stores/config-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  type ControlSpec,
  controlKindFor,
  isLeafHintPath,
  type JsonSchemaNode,
  primitiveOrUndefined,
  schemaNodeAtPath,
  type UiHint,
} from "./settings-schema";

type ReloadRule = { prefix: string; kind: "restart" | "hot" | "none" };

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

/** The gateway redacts secrets to a sentinel; the legacy UI test fixtures use "***". */
function isRedacted(value: unknown): boolean {
  return (
    typeof value === "string" && (value === "__BITTERBOT_REDACTED__" || value.startsWith("***"))
  );
}

type Row = {
  path: string;
  hint: UiHint;
  node: JsonSchemaNode | undefined;
  spec: ControlSpec;
  /** Present in the user's config file (or its load-time defaults). */
  isSet: boolean;
};

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
  // `resolved` is the file after env substitution but BEFORE load-time
  // defaults: the honest answer to "did the user set this?". Older gateways
  // omit it; then "set" falls back to "present in config".
  const resolvedRaw = (snapshot as { resolved?: unknown }).resolved;
  const resolved =
    resolvedRaw && typeof resolvedRaw === "object"
      ? (resolvedRaw as Record<string, unknown>)
      : config;
  const hints = (schema?.uiHints ?? {}) as Record<string, UiHint>;
  const jsonSchema = schema?.schema;
  const reloadRules = ((schema as { reloadRules?: ReloadRule[] } | null)?.reloadRules ??
    []) as ReloadRule[];

  const [search, setSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dirty, setDirty] = useState<Map<string, unknown>>(new Map());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [restartPending, setRestartPending] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Every hinted leaf the form could in principle show, with its control.
  const leaves = useMemo(() => {
    const out: Row[] = [];
    for (const [path, hint] of Object.entries(hints)) {
      if (!isLeafHintPath(path)) {
        continue;
      }
      const node = jsonSchema ? schemaNodeAtPath(jsonSchema, path) : undefined;
      const value = getAtPath(config, path);
      const spec = controlKindFor(node, value);
      out.push({ path, hint, node, spec, isSet: getAtPath(resolved, path) !== undefined });
    }
    return out;
  }, [hints, jsonSchema, config, resolved]);

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = leaves.filter(({ path, hint, spec, isSet }) => {
      const value = getAtPath(config, path);
      if (value !== undefined && primitiveOrUndefined(value) === undefined) {
        return false; // objects/arrays live in the raw editor
      }
      if (hint.deprecated) {
        // Never offered; shown read-only (with the reason) only while the
        // file still sets it, so a user can see what the load warning means.
        return isSet && value !== undefined;
      }
      const shown =
        isSet ||
        value !== undefined ||
        hint.default !== undefined ||
        added.has(path) ||
        dirty.has(path);
      if (!shown) {
        return false;
      }
      if (hint.readOnly && value === undefined) {
        return false;
      }
      if (!hint.readOnly && spec.kind === "unknown") {
        return false;
      }
      if (hint.advanced && !showAdvanced && !added.has(path) && !dirty.has(path)) {
        return false;
      }
      if (q) {
        const hay = `${path} ${hint.label ?? ""} ${hint.help ?? ""}`.toLowerCase();
        if (!hay.includes(q)) {
          return false;
        }
      }
      return true;
    });
    const byGroup = new Map<string, Row[]>();
    for (const row of visible) {
      const seg = row.path.split(".")[0];
      const list = byGroup.get(seg) ?? [];
      list.push(row);
      byGroup.set(seg, list);
    }
    return Array.from(byGroup.entries())
      .map(([seg, rows]) => ({
        seg,
        title: hints[seg]?.label ?? seg,
        help: hints[seg]?.help,
        order: hints[seg]?.order ?? 999,
        rows: rows.toSorted((a, b) => a.path.localeCompare(b.path)),
      }))
      .toSorted((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }, [leaves, hints, config, search, showAdvanced, added, dirty]);

  // "Add setting" candidates: unset, no default, editable, not already shown.
  const addable = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    return leaves
      .filter(({ path, hint, spec, isSet }) => {
        if (hint.readOnly || hint.deprecated || spec.kind === "unknown") {
          return false;
        }
        if (isSet || getAtPath(config, path) !== undefined || hint.default !== undefined) {
          return false;
        }
        if (added.has(path)) {
          return false;
        }
        if (q) {
          const hay = `${path} ${hint.label ?? ""}`.toLowerCase();
          return hay.includes(q);
        }
        return true;
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));
  }, [leaves, config, added, addQuery]);

  const effective = (row: Row): unknown => {
    if (dirty.has(row.path)) {
      return dirty.get(row.path);
    }
    const value = getAtPath(config, row.path);
    return value === undefined ? row.hint.default : value;
  };

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

  const addRow = (row: Row) => {
    // The row starts CLEAN: no value is seeded and nothing is dirty until the
    // user acts on it, so Save can never write a value nobody chose (the
    // first enum option, 0, false...).
    setAdded(new Set(added).add(row.path));
    setAddOpen(false);
    setAddQuery("");
  };

  const removeAddedRow = (path: string) => {
    const nextAdded = new Set(added);
    nextAdded.delete(path);
    setAdded(nextAdded);
    const nextDirty = new Map(dirty);
    nextDirty.delete(path);
    setDirty(nextDirty);
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
      setAdded(new Set());
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
        <div className="sticky top-0 z-10 flex items-center gap-3 p-3 rounded-lg bg-warning/10 border border-warning/30 text-warning text-sm">
          <span className="flex-1">Saved. Some changes need a gateway restart to take effect.</span>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warning/20 hover:bg-warning/40 border border-warning/40 transition-colors disabled:opacity-50"
          >
            <RotateCw className={cn("w-3.5 h-3.5", restarting && "animate-spin")} />
            {restarting ? "Restarting…" : "Restart now"}
          </button>
          <button
            onClick={() => setRestartPending(false)}
            className="text-warning/60 hover:text-warning"
          >
            Later
          </button>
        </div>
      )}

      {/* Toolbar: search + advanced + add + save */}
      <div className="flex items-center gap-3 flex-wrap">
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
          <Switch
            checked={showAdvanced}
            onCheckedChange={setShowAdvanced}
            aria-label="Show advanced"
          />
          Show advanced
        </label>
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-border/30 hover:bg-muted/40 transition-colors"
          aria-expanded={addOpen}
        >
          {addOpen ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          Add setting
        </button>
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
            "bg-brand text-white hover:bg-brand/90 disabled:opacity-40",
          )}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {addOpen && (
        <div
          className="rounded-lg border border-border/10 bg-muted/20 p-3 space-y-2"
          data-testid="add-setting-panel"
        >
          <p className="text-xs text-muted-foreground">
            Keys that are not in your config and have no default. Pick one to add a row, then set
            its value and save.
          </p>
          <Input
            value={addQuery}
            onChange={(e) => setAddQuery(e.target.value)}
            placeholder="Search keys…"
            aria-label="Search keys to add"
            className="h-8 text-sm max-w-sm"
          />
          <ul className="max-h-64 overflow-y-auto divide-y divide-border/5">
            {addable.slice(0, 40).map((row) => (
              <li key={row.path}>
                <button
                  onClick={() => addRow(row)}
                  className="w-full text-left px-2 py-1.5 hover:bg-muted/40 rounded"
                >
                  <span className="text-sm">{row.hint.label ?? row.path}</span>
                  <span className="ml-2 text-2xs font-mono text-muted-foreground/60">
                    {row.path}
                  </span>
                </button>
              </li>
            ))}
            {addable.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">No keys match.</li>
            )}
          </ul>
        </div>
      )}

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
            {section.help && <p className="text-xs text-muted-foreground mt-1">{section.help}</p>}
          </div>
          <div className="divide-y divide-border/5">
            {section.rows.map((row) => {
              const { path, hint } = row;
              const value = effective(row);
              const kind = reloadKindForPath(path, reloadRules);
              const isDirty = dirty.has(path);
              const setValueOf = getAtPath(config, path);
              const fromDefault =
                !isDirty && setValueOf === undefined && hint.default !== undefined;
              const pinnedDefault = !isDirty && !row.isSet && setValueOf !== undefined;
              return (
                <div key={path} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn("text-sm", isDirty && "text-brand")}>
                        {hint.label ?? path}
                      </span>
                      {hint.deprecated && (
                        <span
                          title={hint.deprecated}
                          className="px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide bg-danger/10 text-danger border border-danger/20"
                        >
                          deprecated
                        </span>
                      )}
                      {(fromDefault || pinnedDefault) && (
                        <span
                          title="Not set in your config; this is the value Bitterbot uses"
                          className="px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide bg-muted/60 text-muted-foreground border border-border/20"
                        >
                          default
                        </span>
                      )}
                      {kind === "restart" && (
                        <span
                          title="Applying this change restarts the gateway"
                          className="px-1.5 py-0.5 rounded text-2xs uppercase tracking-wide bg-warning/10 text-warning border border-warning/20"
                        >
                          restart
                        </span>
                      )}
                    </div>
                    {hint.deprecated ? (
                      <p className="text-xs text-danger/80 mt-0.5">{hint.deprecated}</p>
                    ) : (
                      hint.help && (
                        <p className="text-xs text-muted-foreground mt-0.5">{hint.help}</p>
                      )
                    )}
                    <p className="text-2xs font-mono text-muted-foreground/50 mt-0.5">{path}</p>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-2">
                    <SettingControl
                      row={row}
                      value={value}
                      onChange={(next) => setValue(path, next)}
                    />
                    {added.has(path) && (
                      <button
                        onClick={() => removeAddedRow(path)}
                        title="Remove this row without saving it"
                        aria-label={`Remove ${hint.label ?? path}`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
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

const SELECT_CLASS =
  "h-7 w-56 text-xs font-mono px-2 rounded-md border border-input bg-transparent dark:bg-input/30";

/**
 * Number input with its own text state: "-", "1." and "" are legitimate
 * intermediate keystrokes that `Number()` would turn into NaN or 0. Only a
 * finite number is committed; an emptied field removes the edit (unset key)
 * or writes `null` (merge-patch delete) when the key was set.
 */
function NumberField({
  value,
  label,
  placeholder,
  hasOriginal,
  onChange,
}: {
  value: unknown;
  label: string;
  placeholder?: string;
  hasOriginal: boolean;
  onChange: (value: unknown) => void;
}) {
  const external = typeof value === "number" ? String(value) : "";
  const [text, setText] = useState(external);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) {
      setText(external);
    }
  }, [external, focused]);
  // type="text" on purpose: a number input reports "" for "-" or "1." mid-typing,
  // which this field would have to read as "cleared".
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === "") {
          onChange(hasOriginal ? null : undefined);
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) {
          onChange(n);
        }
      }}
      className="h-7 w-56 text-xs font-mono"
    />
  );
}

function SettingControl({
  row,
  value,
  onChange,
}: {
  row: Row;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { path, hint, spec } = row;
  const label = hint.label ?? path;
  if (hint.readOnly || hint.deprecated) {
    return (
      <span className="text-xs font-mono text-muted-foreground" data-testid={`readonly:${path}`}>
        {value === undefined ? "(unset)" : String(value)}
      </span>
    );
  }
  if (spec.kind === "boolean" && hint.triState) {
    // Unset is a real third state ("no override"), so an OFF switch would lie.
    const selected = value === true ? "true" : value === false ? "false" : "";
    return (
      <select
        value={selected}
        aria-label={label}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? (spec.nullable ? null : undefined) : raw === "true");
        }}
        className={SELECT_CLASS}
      >
        <option value="">(not set)</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (spec.kind === "boolean") {
    return <Switch checked={value === true} onCheckedChange={onChange} aria-label={label} />;
  }
  if (spec.kind === "enum" && spec.options) {
    const options = spec.options;
    const selected = value === null || value === undefined ? "" : String(value);
    return (
      <select
        value={selected}
        aria-label={label}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(spec.nullable ? null : undefined);
            return;
          }
          const match = options.find((o) => o !== null && String(o) === raw);
          onChange(match === undefined ? raw : match);
        }}
        className={SELECT_CLASS}
      >
        {(selected === "" || spec.nullable) && <option value="">(not set)</option>}
        {options
          .filter((o) => o !== null)
          .map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
      </select>
    );
  }
  if (spec.kind === "number") {
    return (
      <NumberField
        value={value}
        label={label}
        placeholder={hint.placeholder}
        hasOriginal={row.isSet || primitiveOrUndefined(value) !== undefined}
        onChange={onChange}
      />
    );
  }
  const redacted = isRedacted(value);
  return (
    <Input
      type={hint.sensitive ? "password" : "text"}
      value={redacted || value === undefined || value === null ? "" : String(value)}
      placeholder={redacted ? "•••••• (set)" : hint.placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-56 text-xs font-mono"
    />
  );
}
