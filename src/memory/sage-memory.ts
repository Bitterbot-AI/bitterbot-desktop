/**
 * PLAN-18 — public façade for the SAGE-style graph memory subsystem.
 *
 * One module to import for callers (search manager, working-memory
 * prompt, agent tools). Composes the Phase 1–5 pieces and exposes a
 * single `sageRetrieve()` entry-point + a small config surface.
 *
 * Each phase is independently gated by the config so partial rollouts
 * are safe.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { graphRead, type GraphReaderResult, type GateFn } from "./graph-reader.js";
import { getOrComputeEdgeFeatures } from "./graph-topology.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { planQuery, planQueryHeuristic, type QueryPlan } from "./query-planner.js";
import {
  createDefaultGate,
  deserializeGate,
  gateValue,
  type GateParameters,
  type HormonalLevels,
} from "./structural-gate.js";

const log = createSubsystemLogger("memory/sage");

export type SageConfig = {
  /** Phase 1: structured query planning. */
  queryPlanning?: { enabled: boolean; llmCall?: (prompt: string) => Promise<string> };
  /** Phase 2: graph reader as RRF channel. */
  graphReader?: { enabled: boolean; hops?: number; maxFrontier?: number; topK?: number };
  /** Phase 3: learned structural gating from gate file. */
  structuralGating?: { enabled: boolean; gateFilePath?: string };
  /** Phase 5: hormonal modulation. */
  hormonalModulation?: { enabled: boolean; getState?: () => HormonalLevels | undefined };
};

export const DEFAULT_SAGE_CONFIG: Required<Pick<SageConfig, "queryPlanning" | "graphReader">> &
  Pick<SageConfig, "structuralGating" | "hormonalModulation"> = {
  queryPlanning: { enabled: true },
  graphReader: { enabled: true, hops: 2, maxFrontier: 200, topK: 50 },
  structuralGating: { enabled: false },
  hormonalModulation: { enabled: false },
};

export type SageRetrievalResult = {
  plan: QueryPlan;
  graph?: GraphReaderResult;
  hormonalSnapshot?: HormonalLevels;
};

function resolveGatePath(p?: string): string {
  if (p) {
    return p;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".bitterbot", "graph_gate.json");
}

function loadGateOrDefault(filePath: string): GateParameters {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const gate = deserializeGate(JSON.parse(raw));
      if (gate) {
        return gate;
      }
    }
  } catch (err) {
    log.debug(`sage gate load failed: ${String(err)}`);
  }
  return createDefaultGate();
}

let cachedGate: { mtimeMs: number; gate: GateParameters; path: string } | null = null;

function getActiveGate(filePath: string): GateParameters {
  try {
    const st = fs.statSync(filePath);
    if (cachedGate && cachedGate.path === filePath && cachedGate.mtimeMs === st.mtimeMs) {
      return cachedGate.gate;
    }
    const gate = loadGateOrDefault(filePath);
    cachedGate = { mtimeMs: st.mtimeMs, gate, path: filePath };
    return gate;
  } catch {
    if (cachedGate && cachedGate.path === filePath) {
      return cachedGate.gate;
    }
    const gate = createDefaultGate();
    cachedGate = { mtimeMs: 0, gate, path: filePath };
    return gate;
  }
}

function buildGateFn(
  db: DatabaseSync,
  gate: GateParameters,
  hormonalState?: HormonalLevels,
): GateFn {
  const cache = new Map<string, ReturnType<typeof getOrComputeEdgeFeatures>>();
  const key = (s: string, t: string) => `${s}|${t}`;
  const lookup = (sid: string, tid: string): ReturnType<typeof getOrComputeEdgeFeatures> | null => {
    const k = key(sid, tid);
    if (cache.has(k)) {
      return cache.get(k) ?? null;
    }
    const row = db
      .prepare(
        `SELECT id FROM relationships
         WHERE source_entity_id = ? AND target_entity_id = ? AND valid_until IS NULL
         ORDER BY weight DESC LIMIT 1`,
      )
      .get(sid, tid) as { id: string } | undefined;
    const feats = row ? getOrComputeEdgeFeatures(db, row.id) : null;
    cache.set(k, feats);
    return feats;
  };
  return (input) => {
    const feats = lookup(input.sourceId, input.targetId) ?? lookup(input.targetId, input.sourceId);
    if (!feats) {
      return 1;
    }
    return gateValue(gate, feats, {
      relationType: input.relationType,
      hormonalState: hormonalState ?? input.hormonalState,
    });
  };
}

/**
 * Run the SAGE pipeline for a single query.
 *
 * - Phase 1 plans (or heuristic-plans) the query.
 * - Phase 2 runs the graph reader if enabled.
 * - Phase 3 wires a learned gate function if a gate file is present.
 * - Phase 5 modulates by hormonal state when enabled.
 *
 * The returned object always includes the plan; `graph` is omitted
 * when the graph reader is disabled.
 */
export async function sageRetrieve(
  db: DatabaseSync,
  kg: KnowledgeGraphManager,
  rawQuery: string,
  config: SageConfig = DEFAULT_SAGE_CONFIG,
): Promise<SageRetrievalResult> {
  const qpCfg = config.queryPlanning ?? DEFAULT_SAGE_CONFIG.queryPlanning;
  const grCfg = config.graphReader ?? DEFAULT_SAGE_CONFIG.graphReader;
  const gateCfg = config.structuralGating;
  const hormCfg = config.hormonalModulation;

  const plan = qpCfg.enabled
    ? await planQuery(rawQuery, { llmCall: qpCfg.llmCall })
    : planQueryHeuristic(rawQuery);

  if (!grCfg.enabled) {
    return { plan };
  }

  const hormonalSnapshot = hormCfg?.enabled && hormCfg.getState ? hormCfg.getState() : undefined;

  let gateFn: GateFn | undefined;
  if (gateCfg?.enabled) {
    const gate = getActiveGate(resolveGatePath(gateCfg.gateFilePath));
    gateFn = buildGateFn(db, gate, hormonalSnapshot);
  }

  const graph = graphRead(db, kg, plan, {
    hops: grCfg.hops,
    maxFrontier: grCfg.maxFrontier,
    topK: grCfg.topK,
    gateFn,
    hormonalState: hormonalSnapshot,
  });

  return { plan, graph, hormonalSnapshot };
}

/** Visible for tests. */
export function _resetSageGateCache(): void {
  cachedGate = null;
}
