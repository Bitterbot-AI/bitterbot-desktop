// PLAN-25: the HarnessPolicy is the single typed, versioned object the embedded
// runner reads at session start for every control surface the self-optimizing
// loop is allowed to evolve. The runner reads the *active* policy (config
// baseline overlaid with the latest promoted evolution); the autonomous loop
// only ever edits this object, never runner source.
//
// SAFETY MODEL (structural, not policed): surfaces the autonomous proposer must
// NEVER touch (bash allowlist width, sandbox.mode, safety interceptors,
// acceptHighRiskDiff, P2P propagation) are deliberately NOT fields of
// HarnessPolicy. parseHarnessPolicy() whitelists known fields and drops
// everything else, so a malformed or adversarial candidate cannot introduce a
// forbidden surface — there is no field for it to land in.
//
// Wired surfaces (enforced at runtime):
//   - compaction      → extensions.ts (buildEmbeddedExtensionPaths)
//   - prompt.fragments → appended to the system prompt (renderPromptFragments)
//   - tools.descriptionOverrides → applied to tool defs (applyToolDescriptionOverrides)

import type { AgentCompactionMode, BitterbotConfig } from "../../config/config.js";

/** Caps that bound how far a single evolved policy can drift. Enforced in parse. */
export const POLICY_LIMITS = {
  maxFragments: 12,
  maxFragmentLen: 2000,
  maxToolOverrides: 24,
  maxToolOverrideLen: 1200,
} as const;

// Surfaces the autonomous loop may edit. Compaction is a wired surface too, but
// it stays CONFIG-driven (numeric params are ill-suited to LLM-judge validation),
// so the loop evolves only the two text surfaces the judge can reason about.
export const EVOLVABLE_SURFACES = ["prompt", "tools"] as const;
export type EvolvableSurface = (typeof EVOLVABLE_SURFACES)[number];

export interface HarnessCompactionPolicy {
  mode: AgentCompactionMode;
  maxHistoryShare?: number;
}

/** A single appended system-prompt instruction block, ordered deterministically. */
export interface HarnessPromptFragment {
  id: string;
  text: string;
  order: number;
}

export interface HarnessPromptPolicy {
  fragments: HarnessPromptFragment[];
}

export interface HarnessToolsPolicy {
  /** Per-tool description rewrites. Unknown tool names are ignored at apply time. */
  descriptionOverrides: Record<string, string>;
}

export interface HarnessPolicy {
  /** Monotonic version, mirrors the skills-archive convention. v0 == baseline. */
  version: number;
  /** How this policy came to be live. The autonomous loop only ever writes "evolved". */
  provenance: "default" | "human" | "evolved";
  compaction: HarnessCompactionPolicy;
  prompt: HarnessPromptPolicy;
  tools: HarnessToolsPolicy;
}

/**
 * The behavior-neutral baseline: byte-for-byte the runner's behavior before
 * PLAN-25 (no prompt fragments, no tool overrides, compaction default).
 */
export function defaultHarnessPolicy(): HarnessPolicy {
  return {
    version: 0,
    provenance: "default",
    compaction: { mode: "default" },
    prompt: { fragments: [] },
    tools: { descriptionOverrides: {} },
  };
}

/**
 * Build the config-derived baseline policy. This is the ONLY place config-tree
 * reads for evolvable surfaces happen. An evolved policy is later overlaid on
 * top of this via {@link mergeActivePolicy}, so config remains the floor.
 */
export function resolveHarnessPolicy(cfg: BitterbotConfig | undefined): HarnessPolicy {
  const compactionCfg = cfg?.agents?.defaults?.compaction;
  return {
    version: 0,
    provenance: "default",
    compaction: {
      mode: compactionCfg?.mode === "safeguard" ? "safeguard" : "default",
      maxHistoryShare: compactionCfg?.maxHistoryShare,
    },
    prompt: { fragments: [] },
    tools: { descriptionOverrides: {} },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Whitelist-parse an untrusted candidate (e.g. LLM proposer output or a policy
 * file on disk) into a HarnessPolicy. Unknown keys are dropped, caps enforced.
 * Returns null only if the input is not an object at all. This is the structural
 * safety boundary: forbidden surfaces have no field to land in.
 */
export function parseHarnessPolicy(raw: unknown): HarnessPolicy | null {
  if (!isRecord(raw)) return null;
  const out = defaultHarnessPolicy();

  if (typeof raw.version === "number" && Number.isFinite(raw.version) && raw.version >= 0) {
    out.version = Math.floor(raw.version);
  }
  if (raw.provenance === "human" || raw.provenance === "evolved" || raw.provenance === "default") {
    out.provenance = raw.provenance;
  }

  if (isRecord(raw.compaction)) {
    out.compaction.mode = raw.compaction.mode === "safeguard" ? "safeguard" : "default";
    const share = raw.compaction.maxHistoryShare;
    if (typeof share === "number" && share >= 0.1 && share <= 0.9) {
      out.compaction.maxHistoryShare = share;
    }
  }

  if (isRecord(raw.prompt) && Array.isArray(raw.prompt.fragments)) {
    const seen = new Set<string>();
    for (const f of raw.prompt.fragments) {
      if (out.prompt.fragments.length >= POLICY_LIMITS.maxFragments) break;
      if (!isRecord(f)) continue;
      const id = typeof f.id === "string" ? f.id.trim() : "";
      const text = typeof f.text === "string" ? f.text.trim() : "";
      if (!id || !text || seen.has(id)) continue;
      if (text.length > POLICY_LIMITS.maxFragmentLen) continue;
      const order = typeof f.order === "number" && Number.isFinite(f.order) ? f.order : 0;
      seen.add(id);
      out.prompt.fragments.push({ id, text, order });
    }
  }

  if (isRecord(raw.tools) && isRecord(raw.tools.descriptionOverrides)) {
    let n = 0;
    for (const [tool, desc] of Object.entries(raw.tools.descriptionOverrides)) {
      if (n >= POLICY_LIMITS.maxToolOverrides) break;
      if (typeof desc !== "string") continue;
      const trimmed = desc.trim();
      if (!trimmed || trimmed.length > POLICY_LIMITS.maxToolOverrideLen) continue;
      out.tools.descriptionOverrides[tool] = trimmed;
      n++;
    }
  }

  return out;
}

/**
 * Overlay an evolved policy onto the config baseline. The evolved policy supplies
 * the loop-evolvable text surfaces (prompt + tools); compaction always comes from
 * the config baseline so a later config change is never shadowed by a stale
 * evolution. With no evolved policy this returns the baseline unchanged.
 */
export function mergeActivePolicy(baseline: HarnessPolicy, evolved: HarnessPolicy): HarnessPolicy {
  return {
    version: evolved.version,
    provenance: evolved.provenance,
    compaction: { ...baseline.compaction },
    prompt: { fragments: [...evolved.prompt.fragments] },
    tools: { descriptionOverrides: { ...evolved.tools.descriptionOverrides } },
  };
}

/** Stable text rendering of a policy for the LLM judge / version comparison. */
export function serializePolicyForJudge(p: HarnessPolicy): string {
  const frags = [...p.prompt.fragments]
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((f) => `- [${f.id}] ${f.text}`)
    .join("\n");
  const overrides = Object.entries(p.tools.descriptionOverrides)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([t, d]) => `- ${t}: ${d}`)
    .join("\n");
  return [
    `compaction.mode=${p.compaction.mode}`,
    `compaction.maxHistoryShare=${p.compaction.maxHistoryShare ?? "default"}`,
    `prompt.fragments:\n${frags || "(none)"}`,
    `tools.descriptionOverrides:\n${overrides || "(none)"}`,
  ].join("\n");
}

export interface PolicyDiffSummary {
  surfacesTouched: EvolvableSurface[];
  fragmentAdds: number;
  fragmentRemoves: number;
  toolOverrideChanges: number;
  /** Total number of distinct field changes — used for the minimality check. */
  changeCount: number;
}

/**
 * Compute a structural diff between two policies over the loop-evolvable surfaces
 * (prompt + tools) for audit + the minimality gate. Compaction is excluded
 * because the loop does not evolve it (see EVOLVABLE_SURFACES).
 */
export function policyDiffSummary(base: HarnessPolicy, cand: HarnessPolicy): PolicyDiffSummary {
  const baseFrags = new Map(base.prompt.fragments.map((f) => [f.id, f.text]));
  const candFrags = new Map(cand.prompt.fragments.map((f) => [f.id, f.text]));
  let fragmentAdds = 0;
  let fragmentRemoves = 0;
  for (const [id, text] of candFrags) {
    if (!baseFrags.has(id) || baseFrags.get(id) !== text) fragmentAdds++;
  }
  for (const id of baseFrags.keys()) {
    if (!candFrags.has(id)) fragmentRemoves++;
  }

  const baseOv = base.tools.descriptionOverrides;
  const candOv = cand.tools.descriptionOverrides;
  const ovKeys = new Set([...Object.keys(baseOv), ...Object.keys(candOv)]);
  let toolOverrideChanges = 0;
  for (const k of ovKeys) {
    if (baseOv[k] !== candOv[k]) toolOverrideChanges++;
  }

  const surfacesTouched: EvolvableSurface[] = [];
  if (fragmentAdds + fragmentRemoves > 0) surfacesTouched.push("prompt");
  if (toolOverrideChanges > 0) surfacesTouched.push("tools");

  return {
    surfacesTouched,
    fragmentAdds,
    fragmentRemoves,
    toolOverrideChanges,
    changeCount: fragmentAdds + fragmentRemoves + toolOverrideChanges,
  };
}

/** Render the evolved prompt fragments as appendable system-prompt text. */
export function renderPromptFragments(p: HarnessPolicy): string {
  if (p.prompt.fragments.length === 0) return "";
  return [...p.prompt.fragments]
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((f) => f.text)
    .join("\n\n");
}

/**
 * Apply per-tool description overrides to a list of tool-like objects. Returns a
 * new array; only tools whose name has an override are changed; unknown override
 * names are ignored. Identity when there are no overrides.
 */
export function applyToolDescriptionOverrides<T extends { name: string; description?: string }>(
  tools: readonly T[],
  p: HarnessPolicy,
): T[] {
  const overrides = p.tools.descriptionOverrides;
  if (Object.keys(overrides).length === 0) return [...tools];
  return tools.map((t) =>
    Object.prototype.hasOwnProperty.call(overrides, t.name)
      ? { ...t, description: overrides[t.name] }
      : t,
  );
}
