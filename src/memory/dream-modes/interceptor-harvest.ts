/**
 * PLAN-20 Phase 3: Interceptor Harvest dream mode.
 *
 * Mines the `intervention_records` table for failure clusters that recur
 * across hormonal/gccrf bands and tool shapes, then proposes new
 * candidate interceptors via the LLM synthesis path. Candidates are
 * persisted as DreamInsights of mode `interceptor_harvest` and surfaced
 * to the UI as staging proposals.
 *
 * Heavy work (esbuild compile validation, SICA staging promotion) is left
 * to the user-approval step in the marketplace UI. This pass only:
 *  1. Clusters records.
 *  2. Identifies high-failure / high-override clusters.
 *  3. Generates candidate interceptor JSON specifications.
 *  4. Persists them as DreamInsights with a structured payload.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DreamInsight, EmbedBatchFn, SynthesizeFn } from "../dream-types.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  renderSkillMd,
  synthesizeInterceptorCandidate,
  type CandidateSpec,
} from "./synthesize-interceptor-candidate.js";

const log = createSubsystemLogger("memory/dream/interceptor-harvest");

const MIN_CLUSTER_SIZE = 3; // lowered from 5 for early-life agents
const MAX_CLUSTERS = 5;
const HARVEST_WINDOW_DAYS = 7;
const NEGATIVE_OUTCOMES = new Set(["downstream-failure", "user-overrode-block"]);

interface InterventionRecordRow {
  id: string;
  ts: number;
  skill: string;
  interceptor_id: string;
  channel: string;
  tool_name: string;
  intervention_type: string;
  outcome_tag: string | null;
  action_original_json: string;
  state_summary_json: string;
}

interface HarvestCluster {
  toolName: string;
  channel: string;
  cohortSize: number;
  failureRate: number;
  sampleRecordIds: string[];
  shape: string;
}

export interface HarvestResult {
  insights: DreamInsight[];
  llmCalls: number;
  recordsAnalyzed: number;
}

interface HarvestArgs {
  db: DatabaseSync;
  cycleId: string;
  synthesizeFn: SynthesizeFn | null;
  embedFn: EmbedBatchFn | null;
  /** Direct LLM call (cloud-tier). Used for typed candidate synthesis. */
  llmCall: ((prompt: string) => Promise<string>) | null;
  nowMs: number;
  maxRecords: number;
  /** Override for tests. Defaults to <stateDir>/skills-staging. */
  stagingDirOverride?: string;
}

function fingerprintParams(json: string): string {
  // Cheap shape fingerprint: tool + sorted top-level keys. Avoids LLM
  // calls for trivial grouping.
  try {
    const parsed = JSON.parse(json) as { toolName?: string; params?: Record<string, unknown> };
    const keys = parsed.params ? Object.keys(parsed.params).toSorted().join(",") : "";
    return `${parsed.toolName ?? "?"}::${keys}`;
  } catch {
    return "?";
  }
}

function pickHormoneBand(json: string): string {
  try {
    const summary = JSON.parse(json) as {
      hormonal?: { cortisol?: number };
      channel?: string;
    };
    const c = summary.hormonal?.cortisol ?? 0;
    if (c < 0.1) return "calm";
    if (c < 0.4) return "warm";
    return "stress";
  } catch {
    return "unknown";
  }
}

export async function runInterceptorHarvest(args: HarvestArgs): Promise<HarvestResult> {
  const cutoff = args.nowMs - HARVEST_WINDOW_DAYS * 86_400_000;
  let rows: InterventionRecordRow[];
  try {
    rows = args.db
      .prepare(
        `SELECT id, ts, skill, interceptor_id, channel, tool_name, intervention_type,
              outcome_tag, action_original_json, state_summary_json
         FROM intervention_records
         WHERE ts >= ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(cutoff, args.maxRecords) as unknown as InterventionRecordRow[];
  } catch (err) {
    log.debug(`harvest skipped: ${String(err)}`);
    return { insights: [], llmCalls: 0, recordsAnalyzed: 0 };
  }

  if (rows.length === 0) {
    return { insights: [], llmCalls: 0, recordsAnalyzed: 0 };
  }

  // Cluster by (tool shape, channel, hormonal band). Track per-cluster
  // outcome distribution.
  const buckets = new Map<
    string,
    {
      toolName: string;
      channel: string;
      shape: string;
      rows: InterventionRecordRow[];
      failures: number;
    }
  >();
  for (const r of rows) {
    const shape = fingerprintParams(r.action_original_json);
    const band = pickHormoneBand(r.state_summary_json);
    const key = `${r.tool_name}|${r.channel}|${band}|${shape}`;
    let b = buckets.get(key);
    if (!b) {
      b = { toolName: r.tool_name, channel: r.channel, shape, rows: [], failures: 0 };
      buckets.set(key, b);
    }
    b.rows.push(r);
    if (r.outcome_tag && NEGATIVE_OUTCOMES.has(r.outcome_tag)) {
      b.failures += 1;
    }
  }

  const clusters: HarvestCluster[] = [];
  for (const b of buckets.values()) {
    if (b.rows.length < MIN_CLUSTER_SIZE) continue;
    const failureRate = b.failures / b.rows.length;
    if (failureRate < 0.4) continue;
    clusters.push({
      toolName: b.toolName,
      channel: b.channel,
      cohortSize: b.rows.length,
      failureRate,
      sampleRecordIds: b.rows.slice(0, 3).map((r) => r.id),
      shape: b.shape,
    });
  }
  clusters.sort((a, b) => b.failureRate - a.failureRate);
  const top = clusters.slice(0, MAX_CLUSTERS);
  if (top.length === 0) {
    return { insights: [], llmCalls: 0, recordsAnalyzed: rows.length };
  }

  // For each surviving cluster, propose a candidate interceptor.
  // Priority: typed LLM synthesis (writes a SKILL.md to skills-staging)
  // → heuristic text fallback. The DreamInsight content is always the
  // human-readable summary so the Active Guards UI can render it.
  const insights: DreamInsight[] = [];
  let llmCalls = 0;
  // PLAN-42 Phase 0: staging path comes from the shared skill-storage module
  // (was a parallel resolveStateDir construction that could drift).
  const stagingDir = args.stagingDirOverride ?? resolveStorageRoots().stagingRoot;

  for (const cluster of top) {
    let candidateSpec: CandidateSpec | null = null;
    let stagingPath: string | null = null;

    if (args.llmCall) {
      const sampleParams = await loadSampleParams(args.db, cluster.sampleRecordIds);
      const result = await synthesizeInterceptorCandidate({
        llmCall: args.llmCall,
        cluster: {
          toolName: cluster.toolName,
          channel: cluster.channel,
          shape: cluster.shape,
          cohortSize: cluster.cohortSize,
          failureRate: cluster.failureRate,
          sampleParams,
        },
      });
      llmCalls += 1;
      if (result.ok) {
        candidateSpec = result.spec;
        try {
          stagingPath = await writeStagedCandidate(stagingDir, result.spec);
          log.debug(`harvest: staged candidate ${result.spec.id} at ${stagingPath}`);
        } catch (err) {
          log.debug(`harvest: failed to stage candidate ${result.spec.id}: ${String(err)}`);
        }
      } else {
        log.debug(`harvest: candidate synthesis failed: ${result.reason}`);
      }
    }

    const proposalText = buildProposalText(cluster, candidateSpec, stagingPath);
    insights.push({
      id: randomUUID(),
      content: proposalText,
      embedding: [],
      confidence: clusterConfidence(cluster),
      mode: "interceptor_harvest",
      sourceChunkIds: [],
      sourceClusterIds: cluster.sampleRecordIds,
      dreamCycleId: args.cycleId,
      importanceScore: 0.5 + cluster.failureRate * 0.4,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
  }

  return { insights, llmCalls, recordsAnalyzed: rows.length };
}

async function loadSampleParams(
  db: DatabaseSync,
  ids: ReadonlyArray<string>,
): Promise<Array<Record<string, unknown>>> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  let rows: Array<{ action_original_json: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT action_original_json FROM intervention_records WHERE id IN (${placeholders})`,
      )
      .all(...ids) as unknown as Array<{ action_original_json: string }>;
  } catch (err) {
    log.debug(`loadSampleParams failed: ${String(err)}`);
    return [];
  }
  return rows
    .map((r) => {
      try {
        const parsed = JSON.parse(r.action_original_json) as { params?: unknown };
        if (parsed?.params && typeof parsed.params === "object") {
          return parsed.params as Record<string, unknown>;
        }
        return null;
      } catch {
        return null;
      }
    })
    .filter((r): r is Record<string, unknown> => r !== null);
}

async function writeStagedCandidate(stagingDir: string, spec: CandidateSpec): Promise<string> {
  const skillDir = path.join(stagingDir, spec.skill);
  await fs.mkdir(skillDir, { recursive: true });
  const skillMd = renderSkillMd(spec);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillMdPath, skillMd, "utf8");
  const metaPath = path.join(skillDir, ".staging-meta.json");
  const meta = {
    source: "interceptor_harvest",
    stagedAt: Date.now(),
    candidateId: spec.id,
    requiresImplementation: true,
  };
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return skillMdPath;
}

function buildProposalText(
  cluster: HarvestCluster,
  spec: CandidateSpec | null,
  stagingPath: string | null,
): string {
  if (spec) {
    return [
      `## Candidate interceptor: ${spec.skill}`,
      "",
      `**Activation:** ${spec.activation.description}`,
      `**Intervention:** ${spec.intervention.type} — ${spec.intervention.description || "(no description)"}`,
      `**Rationale:** ${spec.rationale}`,
      "",
      `**Cohort:** ${cluster.cohortSize} records, ${(cluster.failureRate * 100).toFixed(0)}% negative outcomes`,
      `**Tools:** ${spec.tools.join(", ")}`,
      `**Priority:** ${spec.priority}`,
      stagingPath ? `**Staged at:** ${stagingPath}` : "",
      "",
      "Promote via the Active Guards panel to land in `skills/`. A TypeScript implementation must be added under `src/agents/skills/builtin-interceptors/` before this skill becomes live; mesh-acquired user-authored interceptors remain gated on issue #21.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }
  // Heuristic-only fallback.
  return [
    `## Candidate interceptor proposal (heuristic)`,
    `Tool: ${cluster.toolName}`,
    `Channel: ${cluster.channel}`,
    `Shape: ${cluster.shape}`,
    `Cohort: ${cluster.cohortSize} records with ${(cluster.failureRate * 100).toFixed(0)}% negative outcomes`,
    ``,
    `Proposed behaviour:`,
    `- shouldActivate: when toolName === "${cluster.toolName}" and channel === "${cluster.channel}" and params match shape "${cluster.shape}"`,
    `- intervene: require_prereq or modify based on observed pattern`,
    ``,
    `Sample records: ${cluster.sampleRecordIds.join(", ")}`,
    ``,
    `No LLM available this cycle. Re-run dream once an LLM provider is configured to produce a typed candidate.`,
  ].join("\n");
}

function clusterConfidence(c: HarvestCluster): number {
  // Confidence rises with cohort size + failure rate but caps at 0.95.
  const size = Math.min(1, c.cohortSize / 20);
  return Math.min(0.95, c.failureRate * 0.6 + size * 0.4);
}

export const __testing = {
  MIN_CLUSTER_SIZE,
  MAX_CLUSTERS,
  HARVEST_WINDOW_DAYS,
  loadSampleParams,
  writeStagedCandidate,
  buildProposalText,
};
