/**
 * PLAN-18 Phase 3 — dream-engine integration hook.
 *
 * The dream engine calls `maybeRunGraphOptimization()` at the end of
 * each cycle. The hook silently no-ops when the substrate is missing
 * (no training pairs yet, cooldown not elapsed, hormonal arousal too
 * high, feature flag off). When it does run, it loads the current
 * gate, executes one optimization cycle, persists improved gates, and
 * writes the reward delta into the `dream_cycles` row that just
 * finished.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  evaluateGate,
  gateToJsonString,
  readTrainingPairs,
  runOptimizationCycle,
  type OptimizerResult,
} from "./graph-optimizer.js";
import { recomputeFeaturesForRelationships, unpackFeatures } from "./graph-topology.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import {
  createDefaultGate,
  deserializeGate,
  gateValue,
  type GateParameters,
  type HormonalLevels,
} from "./structural-gate.js";

const log = createSubsystemLogger("memory/graph-optimization-hook");

export type HookConfig = {
  /** Master flag. Default false (opt-in). */
  enabled?: boolean;
  /** Absolute path to the gate file. Default: ~/.bitterbot/graph_gate.json. */
  gateFilePath?: string;
  /** Minimum training pairs required before running. Default 50. */
  minTrainingPairs?: number;
  /** Cooldown between runs (ms). Default 6h. */
  cooldownMs?: number;
  /** Hormonal state at hook fire-time (Phase 5). */
  hormonalState?: HormonalLevels;
  /** Hook overrides forwarded to the optimizer. */
  optimizer?: {
    population?: number;
    generations?: number;
    initialSigma?: number;
  };
};

const DEFAULT_MIN_PAIRS = 50;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60_000;

let lastRunAt = 0;

export function _resetCooldown(): void {
  lastRunAt = 0;
}

function resolveGatePath(p?: string): string {
  if (p) {
    return p;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".bitterbot", "graph_gate.json");
}

function loadGate(filePath: string): GateParameters {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const gate = deserializeGate(parsed);
      if (gate) {
        return gate;
      }
      log.debug(`gate file at ${filePath} malformed — using default`);
    }
  } catch (err) {
    log.debug(`gate file load failed: ${String(err)}`);
  }
  return createDefaultGate();
}

function saveGate(filePath: string, gate: GateParameters): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, gateToJsonString(gate), "utf8");
  } catch (err) {
    log.warn(`gate file save failed: ${String(err)}`);
  }
}

/**
 * Persist the per-edge gate_value column from the current gate. Reads
 * cached features; recomputes them if missing. Skips edges whose
 * features cannot be derived (orphans).
 */
export function materializeGateValues(
  db: DatabaseSync,
  gate: GateParameters,
  hormonalState?: HormonalLevels,
): number {
  // Make sure all active edges have features cached.
  recomputeFeaturesForRelationships(db, null);

  const rows = db
    .prepare(
      `SELECT id, relation_type, gate_features
       FROM relationships WHERE valid_until IS NULL AND gate_features IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    relation_type: string;
    gate_features: Uint8Array | null;
  }>;
  if (rows.length === 0) {
    return 0;
  }

  const update = db.prepare(`UPDATE relationships SET gate_value = ? WHERE id = ?`);
  let updated = 0;
  try {
    db.exec("BEGIN");
    for (const row of rows) {
      const feats = unpackFeatures(row.gate_features);
      if (!feats) {
        continue;
      }
      const g = gateValue(gate, feats, {
        relationType: row.relation_type,
        hormonalState,
      });
      update.run(g, row.id);
      updated++;
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    log.warn(`materializeGateValues failed: ${String(err)}`);
    return 0;
  }
  return updated;
}

/**
 * Run a single optimization cycle if all preconditions hold.
 * Returns null when no work was done.
 */
export function maybeRunGraphOptimization(
  db: DatabaseSync,
  kg: KnowledgeGraphManager,
  config: HookConfig,
  dreamCycleId: string | null = null,
): OptimizerResult | null {
  if (!config.enabled) {
    return null;
  }
  const now = Date.now();
  const cooldown = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (now - lastRunAt < cooldown) {
    return null;
  }
  const minPairs = config.minTrainingPairs ?? DEFAULT_MIN_PAIRS;
  const pairs = readTrainingPairs(db, 500);
  if (pairs.length < minPairs) {
    log.debug("graph optimization skipped — insufficient pairs", {
      have: pairs.length,
      need: minPairs,
    });
    return null;
  }

  // Held-out split: train on first 80%, validate on last 20%.
  const split = Math.max(1, Math.floor(pairs.length * 0.8));
  const train = pairs.slice(0, split);
  const validate = pairs.slice(split);

  const filePath = resolveGatePath(config.gateFilePath);
  const baseline = loadGate(filePath);

  let trainResult: OptimizerResult;
  try {
    trainResult = runOptimizationCycle(db, kg, baseline, train, {
      hormonalState: config.hormonalState,
      population: config.optimizer?.population,
      generations: config.optimizer?.generations,
      initialSigma: config.optimizer?.initialSigma,
    });
  } catch (err) {
    log.warn(`graph optimization cycle failed: ${String(err)}`);
    return null;
  }

  // Validate on held-out before accepting the update — reject regressions.
  let validationDelta = 0;
  if (validate.length > 0) {
    const baseV = evaluateGate(db, kg, baseline, validate, {
      hormonalState: config.hormonalState,
    });
    const bestV = evaluateGate(db, kg, trainResult.bestGate, validate, {
      hormonalState: config.hormonalState,
    });
    validationDelta = bestV.reward - baseV.reward;
    if (validationDelta < 0) {
      log.debug("graph optimization rejected — validation regressed", {
        baselineV: baseV.reward,
        bestV: bestV.reward,
      });
      // Persist the baseline so the live gate file always exists and is
      // consistent with the materialized gate_value column.
      saveGate(filePath, baseline);
      materializeGateValues(db, baseline, config.hormonalState);
      lastRunAt = now;
      writeRewardDelta(db, dreamCycleId, validationDelta);
      return { ...trainResult, bestGate: baseline, improvement: validationDelta };
    }
  }

  saveGate(filePath, trainResult.bestGate);
  materializeGateValues(db, trainResult.bestGate, config.hormonalState);
  writeRewardDelta(db, dreamCycleId, validationDelta || trainResult.improvement);
  lastRunAt = now;
  log.info("graph optimization accepted", {
    baseline: trainResult.baselineReward,
    best: trainResult.bestReward,
    validationDelta,
    evaluations: trainResult.evaluations,
    wallTimeMs: trainResult.wallTimeMs,
  });
  return trainResult;
}

function writeRewardDelta(db: DatabaseSync, dreamCycleId: string | null, delta: number): void {
  if (!dreamCycleId) {
    return;
  }
  try {
    db.prepare(`UPDATE dream_cycles SET graph_reward_delta = ? WHERE id = ?`).run(
      delta,
      dreamCycleId,
    );
  } catch (err) {
    log.debug(`writeRewardDelta failed: ${String(err)}`);
  }
}
