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
import type { DreamCluster, DreamInsight, EmbedBatchFn, SynthesizeFn } from "../dream-types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

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
  nowMs: number;
  maxRecords: number;
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
  // If a synthesizeFn (LLM) is available, ask it to draft the typed shape;
  // otherwise emit a heuristic placeholder. The candidate is persisted as
  // a DreamInsight whose content is the proposal text — the UI reads from
  // this row.
  const insights: DreamInsight[] = [];
  let llmCalls = 0;

  for (const cluster of top) {
    const proposalText = await proposeCandidate({
      cluster,
      synthesizeFn: args.synthesizeFn,
    });
    if (proposalText.usedLlm) llmCalls += 1;
    insights.push({
      id: randomUUID(),
      content: proposalText.text,
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

  // Persist insights table is owned by the dream engine; the engine
  // writes them into `dream_insights` (or equivalent) on return. We just
  // return them here.

  return { insights, llmCalls, recordsAnalyzed: rows.length };
}

function clusterConfidence(c: HarvestCluster): number {
  // Confidence rises with cohort size + failure rate but caps at 0.95.
  const size = Math.min(1, c.cohortSize / 20);
  return Math.min(0.95, c.failureRate * 0.6 + size * 0.4);
}

async function proposeCandidate(args: {
  cluster: HarvestCluster;
  synthesizeFn: SynthesizeFn | null;
}): Promise<{ text: string; usedLlm: boolean }> {
  const { cluster } = args;
  const heuristicText = [
    `## Candidate interceptor proposal`,
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
    `Promote via the Active Guards panel to land in skills-staging.`,
  ].join("\n");

  if (!args.synthesizeFn) {
    return { text: heuristicText, usedLlm: false };
  }

  try {
    const fakeClusters: DreamCluster[] = [
      {
        id: cluster.sampleRecordIds[0] ?? "harvest-0",
        chunkIds: cluster.sampleRecordIds,
        centroid: [],
        mode: "convergent",
        meanImportance: cluster.failureRate,
        keywords: [cluster.toolName, cluster.channel, cluster.shape],
      },
    ];
    const chunkTexts = new Map<string, string>([
      [cluster.sampleRecordIds[0] ?? "harvest-0", heuristicText],
    ]);
    const synth = await args.synthesizeFn(fakeClusters, chunkTexts);
    const refined = synth?.[0]?.content;
    if (refined && refined.length > 50) {
      return {
        text: `${refined}\n\n---\n${heuristicText}`,
        usedLlm: true,
      };
    }
  } catch (err) {
    log.debug(`synthesize candidate failed: ${String(err)}`);
  }
  return { text: heuristicText, usedLlm: false };
}
