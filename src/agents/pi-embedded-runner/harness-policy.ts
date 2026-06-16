// PLAN-25 Phase 0: the HarnessPolicy is the single typed, versioned object the
// embedded runner reads at session start for every control surface that the
// self-optimizing loop is allowed to evolve. This file is the keystone: it grows
// one surface per commit, and each surface is fully consumed by the runner the
// moment it lands here (behavior-neutral defaults reproduce today's constants).
//
// Slice 1 (this commit): the compaction / state-management surface, consumed by
// `buildEmbeddedExtensionPaths` in extensions.ts. Subsequent slices add the
// prompt, tools, model, loop, and interceptor surfaces (see docs/plans/PLAN-25).
//
// SAFETY: surfaces the autonomous proposer must NEVER edit (bash allowlist width,
// sandbox.mode, safety interceptors, acceptHighRiskDiff, P2P propagation) are
// deliberately NOT fields of HarnessPolicy. A policy diff cannot name what the
// schema does not contain.

import type { AgentCompactionMode, BitterbotConfig } from "../../config/config.js";

/**
 * Compaction / state-management surface. Mirrors the subset of
 * `AgentCompactionConfig` the runner consumes when wiring the compaction
 * extension. `maxHistoryShare` is left optional so `undefined` preserves the
 * pi-side default (0.5) exactly as the pre-PLAN-25 code did.
 */
export interface HarnessCompactionPolicy {
  mode: AgentCompactionMode;
  maxHistoryShare?: number;
}

/**
 * The runner's evolvable harness. Versioned and archived like a skill
 * (`harness-policy-archive/v<N>/policy.json`) so every promotion is rollback-able.
 * Fields are added one slice at a time; each is wired on arrival.
 */
export interface HarnessPolicy {
  /** Monotonic version, mirrors the skills-archive convention. v0 == defaults. */
  version: number;
  /** How this policy came to be live. The autonomous loop only ever writes "evolved". */
  provenance: "default" | "human" | "evolved";
  compaction: HarnessCompactionPolicy;
}

/**
 * The behavior-neutral baseline: byte-for-byte the runner's behavior before
 * PLAN-25. Phase 0's exit criterion is that resolving an empty config through
 * {@link resolveHarnessPolicy} equals this for every wired surface.
 */
export function defaultHarnessPolicy(): HarnessPolicy {
  return {
    version: 0,
    provenance: "default",
    compaction: { mode: "default" },
  };
}

/**
 * Build the live HarnessPolicy from the current config tree. This is the ONLY
 * place config-tree reads for evolvable surfaces should happen; the runner reads
 * the policy, never the raw config, so an evolved policy can override the static
 * config without changing call sites.
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
  };
}
