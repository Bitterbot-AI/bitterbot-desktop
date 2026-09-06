// PLAN-25 Phase 1: harness-level Weakness Mining. Mines failure traces from
// intervention_records (interceptor outcomes) and skill_executions (skill
// failures) into deterministic failure-signature clusters, tagged with the
// harness SURFACE most likely responsible. Following Self-Harness, clustering is
// exact-match on the signature tuple (no LLM fuzz): two failures group only when
// they agree on ⟨surface, terminal cause, reusable mechanism⟩.

import type { DatabaseSync } from "node:sqlite";

// The harness surface DIAGNOSED as responsible for a failure. This is broader
// than the loop's editable surfaces (compaction failures are diagnosable even
// though the loop fixes them via prompt/tool edits rather than editing
// compaction directly).
export type FailureSurface = "compaction" | "prompt" | "tools";

export interface FailureSignature {
  surface: FailureSurface;
  terminalCause: string;
  mechanism: string;
}

export interface FailureCluster {
  signature: FailureSignature;
  count: number;
  lastTs: number;
  sampleIds: string[];
  exampleDetail: string;
  /**
   * PLAN-45 Phase 1 note: this module reads the TOOL-level `success` bit of
   * skill_executions on purpose. It measures harness policy (PLAN-25, off by
   * default), not skill competence; competence consumers use RUN_EVIDENCE_WHERE.
   * Ranking weight: frequency scaled by recency. Higher = more worth fixing. */
  score: number;
}

export interface MineOptions {
  limit?: number;
  /** Records older than this (ms) are ignored. Default 30 days. */
  maxAgeMs?: number;
  nowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function classifyExecutionSurface(errorType: string | null): FailureSurface {
  const e = (errorType ?? "").toLowerCase();
  if (
    e.includes("timeout") ||
    e.includes("context") ||
    e.includes("token") ||
    e.includes("overflow")
  )
    return "compaction";
  if (e.includes("tool") || e.includes("not_found") || e.includes("route") || e.includes("schema"))
    return "tools";
  return "prompt";
}

function classifyInterventionSurface(outcomeTag: string, interventionType: string): FailureSurface {
  // A user overriding a block means our instruction/guard was wrong → prompt surface.
  if (outcomeTag === "user-overrode-block") return "prompt";
  // A modify/require_prereq/inject that still failed downstream is a routing issue.
  if (["modify", "require_prereq", "inject"].includes(interventionType)) return "tools";
  return "prompt";
}

function bump(
  map: Map<string, FailureCluster>,
  sig: FailureSignature,
  id: string,
  ts: number,
  detail: string,
  now: number,
): void {
  const key = `${sig.surface}|${sig.terminalCause}|${sig.mechanism}`;
  const recency = Math.exp(-(now - ts) / (7 * DAY_MS)); // 7-day half-ish life
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.score += recency;
    existing.lastTs = Math.max(existing.lastTs, ts);
    if (existing.sampleIds.length < 5) existing.sampleIds.push(id);
  } else {
    map.set(key, {
      signature: sig,
      count: 1,
      lastTs: ts,
      sampleIds: [id],
      exampleDetail: detail,
      score: recency,
    });
  }
}

/**
 * Mine failure clusters across both trace stores. Returns clusters sorted by
 * score (frequency × recency) descending. Empty on a fresh install (no traces).
 */
export function mineFailureClusters(db: DatabaseSync, options: MineOptions = {}): FailureCluster[] {
  const now = options.nowMs ?? Date.now();
  const minTs = now - (options.maxAgeMs ?? 30 * DAY_MS);
  const limit = options.limit ?? 300;
  const map = new Map<string, FailureCluster>();

  // 1. intervention_records: interceptor outcomes that went wrong.
  try {
    const rows = db
      .prepare(
        `SELECT id, ts, tool_name, intervention_type, outcome_tag, skill
         FROM intervention_records
         WHERE outcome_tag IN ('downstream-failure','user-overrode-block') AND ts >= ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(minTs, limit) as Array<{
      id: string;
      ts: number;
      tool_name: string;
      intervention_type: string;
      outcome_tag: string;
      skill: string;
    }>;
    for (const r of rows) {
      const surface = classifyInterventionSurface(r.outcome_tag, r.intervention_type);
      bump(
        map,
        {
          surface,
          terminalCause: r.outcome_tag,
          mechanism: `${r.intervention_type}:${r.tool_name}`,
        },
        r.id,
        r.ts,
        `skill=${r.skill} tool=${r.tool_name} type=${r.intervention_type} outcome=${r.outcome_tag}`,
        now,
      );
    }
  } catch {
    // table absent — skip
  }

  // 2. skill_executions: outright skill failures.
  try {
    const rows = db
      .prepare(
        `SELECT id, started_at, error_type, skill_crystal_id
         FROM skill_executions
         WHERE success = 0 AND completed_at IS NOT NULL AND started_at >= ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(minTs, limit) as Array<{
      id: string;
      started_at: number;
      error_type: string | null;
      skill_crystal_id: string;
    }>;
    for (const r of rows) {
      const surface = classifyExecutionSurface(r.error_type);
      bump(
        map,
        {
          surface,
          terminalCause: r.error_type ?? "unknown-error",
          mechanism: `skill:${r.skill_crystal_id}`,
        },
        r.id,
        r.started_at,
        `skill=${r.skill_crystal_id} error=${r.error_type ?? "unknown"}`,
        now,
      );
    }
  } catch {
    // table absent — skip
  }

  return [...map.values()].toSorted((a, b) => b.score - a.score);
}
