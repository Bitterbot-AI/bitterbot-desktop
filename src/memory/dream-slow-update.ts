/**
 * Dream slow-update: longitudinal skill-version regression detection with
 * hormonal/GCCRF clustering (PLAN-21 Phase D).
 *
 * Every K dream cycles, this module re-evaluates each highly-active skill
 * against the held-out selection set under the current SKILL text AND the
 * last N archive versions. Per-task outcomes are classified into one of four
 * categories (SkillOpt Section 3.6 taxonomy), regressions are clustered by
 * the hormonal/GCCRF state captured on the original `intervention_records`
 * trajectory, and clusters with at least `minClusterSize` regressions are
 * enqueued into `mutation_queue` with elevated priority and a context
 * annotation so the next mutation cycle picks them first.
 *
 * Bitterbot-original: the biological-state binding (hormonal + GCCRF) is the
 * axis SkillOpt, SkillReducer, and GEPA all lack. A regression that clusters
 * non-randomly in hormonal space is a falsifiable neuroscience claim the
 * other frameworks cannot produce.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { GCCRFSnapshot, HormonalSnapshot } from "../agents/skills/interceptor.js";
import type { HeldOutExecution } from "./skill-execution-selection.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/dream-slow-update");

// ── Configuration ──────────────────────────────────────────────────────────

export interface SlowUpdateConfig {
  /** Fire the slow update every N dream cycles. Default 10. */
  intervalCycles: number;
  /** How many archived SKILL.md versions to re-evaluate. Default 3. */
  archiveDepth: number;
  /** Minimum cluster size before regressions get surfaced. Default 3. */
  minClusterSize: number;
  /** k for the hormonal-state k-means. Default 4. */
  kHormonal: number;
  /** k-means iterations. Default 20. */
  kMeansIterations: number;
}

export const DEFAULT_SLOW_UPDATE_CONFIG: SlowUpdateConfig = {
  intervalCycles: 10,
  archiveDepth: 3,
  minClusterSize: 3,
  kHormonal: 4,
  kMeansIterations: 20,
};

/**
 * Idempotently add the slow-update schema required by Phase D. Called once
 * from the dream-engine at construction time. Two side effects:
 *
 *   - `mutation_queue.context_annotation` column: JSON-encoded biological
 *     cluster centroid alongside each regression-priority row.
 *   - `skill_text_history` table: preserves prior `chunks.text` whenever the
 *     dream-engine promotes a mutation, so the longitudinal regression has
 *     real prior versions to score against. Without this, agent-authored
 *     skills would have no preserved history (the chunks table is
 *     overwritten on every promotion).
 */
export function ensureSlowUpdateSchema(db: DatabaseSync): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(mutation_queue)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "context_annotation")) {
      db.exec(`ALTER TABLE mutation_queue ADD COLUMN context_annotation TEXT DEFAULT '{}'`);
    }
  } catch (err) {
    log.debug(`ensureSlowUpdateSchema (mutation_queue) failed: ${String(err)}`);
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS skill_text_history (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      promoted_at INTEGER NOT NULL,
      delta REAL,
      strategy TEXT,
      UNIQUE(skill_id, version)
    )`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_skill_text_history_skill ON skill_text_history(skill_id, version DESC)`,
    );
  } catch (err) {
    log.debug(`ensureSlowUpdateSchema (skill_text_history) failed: ${String(err)}`);
  }
}

/**
 * Snapshot the prior skill text before a promotion overwrites it. Idempotent
 * on `(skill_id, version)`. Returns true on success, false on failure (the
 * caller should never block promotion on the snapshot — it is best-effort).
 */
export function snapshotSkillText(
  db: DatabaseSync,
  args: {
    skillId: string;
    version: number;
    text: string;
    promotedAt: number;
    delta?: number;
    strategy?: string;
  },
): boolean {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO skill_text_history (id, skill_id, version, text, promoted_at, delta, strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      args.skillId,
      args.version,
      args.text,
      args.promotedAt,
      args.delta ?? null,
      args.strategy ?? null,
    );
    return true;
  } catch (err) {
    log.debug(`snapshotSkillText failed: ${String(err)}`);
    return false;
  }
}

/** Read the most recent N prior versions for a skill (newest first). */
export function readSkillTextHistory(
  db: DatabaseSync,
  skillId: string,
  depth: number,
): ArchiveVersionRef[] {
  if (depth <= 0) {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT version, text FROM skill_text_history
         WHERE skill_id = ?
         ORDER BY version DESC
         LIMIT ?`,
      )
      .all(skillId, depth) as Array<{ version: number; text: string }>;
    return rows.map((r) => ({ version: r.version, content: r.text }));
  } catch {
    return [];
  }
}

// ── Epoch boundary ─────────────────────────────────────────────────────────

/**
 * Pure: should the slow update fire on this cycle? Returns true when at least
 * `cfg.intervalCycles` have elapsed since the last fire. The dream-engine
 * tracks `currentCycle` and persists `lastSlowUpdateCycle` between cycles.
 */
export function shouldRunSlowUpdate(
  currentCycle: number,
  lastSlowUpdateCycle: number,
  cfg: SlowUpdateConfig = DEFAULT_SLOW_UPDATE_CONFIG,
): boolean {
  if (currentCycle < 0) {
    return false;
  }
  return currentCycle - lastSlowUpdateCycle >= cfg.intervalCycles;
}

// ── 4-way outcome classification ───────────────────────────────────────────

export type RegressionClass =
  | "improvement" // prior failed, current passed
  | "regression" // prior passed, current failed
  | "persistent-failure" // both failed
  | "stable-success"; // both passed

/** Pure. */
export function classifyOutcome(priorPassed: boolean, currentPassed: boolean): RegressionClass {
  if (priorPassed && currentPassed) return "stable-success";
  if (!priorPassed && !currentPassed) return "persistent-failure";
  if (priorPassed && !currentPassed) return "regression";
  return "improvement";
}

export interface OutcomeTrajectory {
  /** Task identity within the selection set (typically execution_id). */
  readonly taskId: string;
  /** The skill these outcomes pertain to. */
  readonly skillId: string;
  /** Archive version compared against. */
  readonly priorVersion: number;
  /** Current SKILL.md version (live). */
  readonly currentVersion: number;
  readonly priorPassed: boolean;
  readonly currentPassed: boolean;
  readonly classification: RegressionClass;
  /** Hormonal snapshot at original execution time. Null when not recoverable. */
  readonly hormonal: HormonalSnapshot | null;
  /** GCCRF snapshot at original execution time. Null when not recoverable. */
  readonly gccrf: GCCRFSnapshot | null;
}

/** Aggregate counts by classification (for the slow-update telemetry). */
export interface OutcomeSummary {
  improvement: number;
  regression: number;
  persistentFailure: number;
  stableSuccess: number;
}

export function summarize(trajectories: ReadonlyArray<OutcomeTrajectory>): OutcomeSummary {
  const out: OutcomeSummary = {
    improvement: 0,
    regression: 0,
    persistentFailure: 0,
    stableSuccess: 0,
  };
  for (const t of trajectories) {
    switch (t.classification) {
      case "improvement":
        out.improvement++;
        break;
      case "regression":
        out.regression++;
        break;
      case "persistent-failure":
        out.persistentFailure++;
        break;
      case "stable-success":
        out.stableSuccess++;
        break;
    }
  }
  return out;
}

// ── Hormonal k-means clustering of regressions ─────────────────────────────

export interface HormonalCentroid {
  readonly dopamine: number;
  readonly cortisol: number;
  readonly oxytocin: number;
}

export interface BiologicalCluster {
  readonly centroid: HormonalCentroid;
  readonly members: ReadonlyArray<OutcomeTrajectory>;
  /** Optional summary statistics for the cluster (mean GCCRF, etc). */
  readonly stats: {
    readonly meanCortisol: number;
    readonly meanDopamine: number;
    readonly size: number;
  };
}

/**
 * Cluster regressions by hormonal-state proximity. Returns only clusters with
 * `>= minClusterSize` members so that single-shot outliers are treated as
 * noise. Trajectories that lack a hormonal snapshot land in an "unknown"
 * synthetic cluster (centroid all zeros) when there are enough of them to
 * meet the size floor — useful when interceptor data is sparse.
 *
 * Deterministic given a seeded RNG (tests pin the seed). Defaults to
 * `Math.random` in prod.
 */
export function bindBiologicalContext(
  regressions: ReadonlyArray<OutcomeTrajectory>,
  cfg: SlowUpdateConfig = DEFAULT_SLOW_UPDATE_CONFIG,
  random: () => number = Math.random,
): BiologicalCluster[] {
  const withHormonal = regressions.filter((r) => r.hormonal !== null);
  const withoutHormonal = regressions.filter((r) => r.hormonal === null);

  const clusters: BiologicalCluster[] = [];
  if (withHormonal.length >= cfg.kHormonal) {
    const k = Math.min(cfg.kHormonal, withHormonal.length);
    const result = kMeansHormonal(withHormonal, k, cfg.kMeansIterations, random);
    for (let i = 0; i < k; i++) {
      const members = withHormonal.filter((_, idx) => result.assignments[idx] === i);
      if (members.length < cfg.minClusterSize) {
        continue;
      }
      clusters.push({
        centroid: result.centroids[i]!,
        members,
        stats: {
          meanCortisol: mean(members.map((m) => m.hormonal!.cortisol)),
          meanDopamine: mean(members.map((m) => m.hormonal!.dopamine)),
          size: members.length,
        },
      });
    }
  } else if (withHormonal.length >= cfg.minClusterSize) {
    // Not enough for k clusters but enough for one. Single cluster with the
    // centroid as the mean of the available snapshots.
    const centroid: HormonalCentroid = {
      dopamine: mean(withHormonal.map((m) => m.hormonal!.dopamine)),
      cortisol: mean(withHormonal.map((m) => m.hormonal!.cortisol)),
      oxytocin: mean(withHormonal.map((m) => m.hormonal!.oxytocin)),
    };
    clusters.push({
      centroid,
      members: withHormonal,
      stats: {
        meanCortisol: centroid.cortisol,
        meanDopamine: centroid.dopamine,
        size: withHormonal.length,
      },
    });
  }

  if (withoutHormonal.length >= cfg.minClusterSize) {
    clusters.push({
      centroid: { dopamine: 0, cortisol: 0, oxytocin: 0 },
      members: withoutHormonal,
      stats: {
        meanCortisol: 0,
        meanDopamine: 0,
        size: withoutHormonal.length,
      },
    });
  }

  return clusters;
}

/**
 * k-means over the (dopamine, cortisol, oxytocin) tuple. Returns centroids
 * plus an assignment per input. Deterministic given a seeded RNG.
 */
function kMeansHormonal(
  inputs: ReadonlyArray<OutcomeTrajectory>,
  k: number,
  iterations: number,
  random: () => number,
): { centroids: HormonalCentroid[]; assignments: number[] } {
  const points = inputs.map((t) => ({
    dopamine: t.hormonal!.dopamine,
    cortisol: t.hormonal!.cortisol,
    oxytocin: t.hormonal!.oxytocin,
  }));

  // k-means++ init: pick the first centroid uniformly at random, then each
  // subsequent centroid as the point with the largest minimum squared
  // distance to the centroids picked so far. Avoids the small-N degenerate
  // collapse you get from picking k uniform random points.
  let centroids: HormonalCentroid[] = [];
  const firstIndex = Math.floor(random() * points.length);
  centroids.push({ ...points[firstIndex]! });
  while (centroids.length < k && centroids.length < points.length) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < points.length; i++) {
      let minD = Infinity;
      for (const c of centroids) {
        const d = squaredDistance(points[i]!, c);
        if (d < minD) minD = d;
      }
      if (minD > bestDist) {
        bestDist = minD;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    centroids.push({ ...points[bestIdx]! });
  }

  const assignments: number[] = Array.from({ length: points.length }, () => 0);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    // Assignment step.
    for (let i = 0; i < points.length; i++) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = squaredDistance(points[i]!, centroids[c]!);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
    // Update step. Use a mutable local shape — HormonalCentroid is readonly
    // for callers but the accumulator inside the inner loop is local.
    interface MutCentroid {
      dopamine: number;
      cortisol: number;
      oxytocin: number;
    }
    const sums: MutCentroid[] = Array.from({ length: k }, () => ({
      dopamine: 0,
      cortisol: 0,
      oxytocin: 0,
    }));
    const counts: number[] = Array.from({ length: k }, () => 0);
    for (let i = 0; i < points.length; i++) {
      const c = assignments[i]!;
      sums[c]!.dopamine += points[i]!.dopamine;
      sums[c]!.cortisol += points[i]!.cortisol;
      sums[c]!.oxytocin += points[i]!.oxytocin;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    centroids = sums.map((s, c) => {
      const n = counts[c] || 1;
      return {
        dopamine: s.dopamine / n,
        cortisol: s.cortisol / n,
        oxytocin: s.oxytocin / n,
      };
    });
  }

  return { centroids, assignments };
}

function squaredDistance(a: HormonalCentroid, b: HormonalCentroid): number {
  const dD = a.dopamine - b.dopamine;
  const dC = a.cortisol - b.cortisol;
  const dO = a.oxytocin - b.oxytocin;
  return dD * dD + dC * dC + dO * dO;
}

// ── mutation_queue priority enqueue ────────────────────────────────────────

/**
 * Write a high-priority `regression-priority` row into `mutation_queue`,
 * carrying the biological-cluster centroid in `context_annotation`. The next
 * mutation cycle picks these up first.
 */
export function enqueueRegressionPriority(
  db: DatabaseSync,
  args: {
    skillId: string;
    cluster: BiologicalCluster;
    priority?: number;
    now?: number;
  },
): { id: string } | null {
  const priority = args.priority ?? 0.9;
  const now = args.now ?? Date.now();
  const id = randomUUID();
  const annotation = JSON.stringify({
    source: "plan21-slow-update",
    clusterSize: args.cluster.members.length,
    centroid: args.cluster.centroid,
    stats: args.cluster.stats,
    sampleTaskIds: args.cluster.members.slice(0, 3).map((m) => m.taskId),
  });
  try {
    db.prepare(
      `INSERT INTO mutation_queue
         (id, skill_crystal_id, strategy, priority, attempts, max_attempts, created_at, context_annotation)
       VALUES (?, ?, 'regression-priority', ?, 0, 3, ?, ?)`,
    ).run(id, args.skillId, priority, now, annotation);
    return { id };
  } catch (err) {
    log.debug(`enqueueRegressionPriority failed: ${String(err)}`);
    return null;
  }
}

// ── Longitudinal regression run ────────────────────────────────────────────

/**
 * Score one pair of skill texts against the held-out selection set, producing
 * per-task paired pass/fail. The dream-engine provides this via an LLM-judge
 * batched call; tests inject a deterministic stub.
 */
export type ScorePairFn = (
  textA: string,
  textB: string,
  selectionSet: ReadonlyArray<HeldOutExecution>,
) => Promise<ReadonlyArray<{ taskId: string; aPassed: boolean; bPassed: boolean }>>;

export interface ArchiveVersionRef {
  readonly version: number;
  readonly content: string;
}

/**
 * Re-evaluate the current SKILL.md against the most recent archived versions.
 * For each (current, archived-v) pair, score every task in the selection set
 * and emit one `OutcomeTrajectory` per task per version classified into the
 * 4-way taxonomy. The hormonal/GCCRF snapshot is joined from
 * `intervention_records` via the original session.
 */
export async function runLongitudinalRegression(args: {
  db: DatabaseSync;
  skillId: string;
  currentVersion: number;
  currentSkillText: string;
  archiveVersions: ReadonlyArray<ArchiveVersionRef>;
  selectionSet: ReadonlyArray<HeldOutExecution>;
  scorePair: ScorePairFn;
}): Promise<OutcomeTrajectory[]> {
  if (args.selectionSet.length === 0 || args.archiveVersions.length === 0) {
    return [];
  }
  const trajectories: OutcomeTrajectory[] = [];
  for (const prior of args.archiveVersions) {
    let outcomes: ReadonlyArray<{ taskId: string; aPassed: boolean; bPassed: boolean }>;
    try {
      // `aPassed` = prior version, `bPassed` = current version. The 4-way
      // classification is built from (priorPassed, currentPassed).
      outcomes = await args.scorePair(prior.content, args.currentSkillText, args.selectionSet);
    } catch (err) {
      log.debug(`scorePair failed for version v${prior.version}: ${String(err)}`);
      continue;
    }
    for (const outcome of outcomes) {
      const source = args.selectionSet.find((s) => s.id === outcome.taskId);
      if (!source) {
        continue;
      }
      const snapshot =
        source.sessionId === null
          ? { hormonal: null, gccrf: null }
          : lookupBiologicalSnapshot(args.db, {
              skillId: args.skillId,
              sessionKey: source.sessionId,
              beforeTs: source.completedAt,
            });
      trajectories.push({
        taskId: outcome.taskId,
        skillId: args.skillId,
        priorVersion: prior.version,
        currentVersion: args.currentVersion,
        priorPassed: outcome.aPassed,
        currentPassed: outcome.bPassed,
        classification: classifyOutcome(outcome.aPassed, outcome.bPassed),
        hormonal: snapshot.hormonal,
        gccrf: snapshot.gccrf,
      });
    }
  }
  return trajectories;
}

// ── Hormonal lookup from intervention_records ──────────────────────────────

/**
 * Look up the most recent hormonal/GCCRF snapshot for a given (skill,
 * session) pair from `intervention_records`. Returns null when no record
 * matches — the slow update tolerates missing state by treating these
 * trajectories as "unknown" cluster members.
 */
export function lookupBiologicalSnapshot(
  db: DatabaseSync,
  args: { skillId: string; sessionKey: string; beforeTs: number },
): { hormonal: HormonalSnapshot | null; gccrf: GCCRFSnapshot | null } {
  try {
    const row = db
      .prepare(
        `SELECT state_summary_json FROM intervention_records
         WHERE skill = ? AND session_key = ? AND ts <= ?
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .get(args.skillId, args.sessionKey, args.beforeTs) as
      | { state_summary_json: string }
      | undefined;
    if (!row || !row.state_summary_json) {
      return { hormonal: null, gccrf: null };
    }
    const parsed = JSON.parse(row.state_summary_json) as {
      hormonal?: HormonalSnapshot;
      gccrf?: GCCRFSnapshot;
    };
    return {
      hormonal: parsed.hormonal ?? null,
      gccrf: parsed.gccrf ?? null,
    };
  } catch {
    return { hormonal: null, gccrf: null };
  }
}

// ── misc ───────────────────────────────────────────────────────────────────

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export const __testing = {
  kMeansHormonal,
  squaredDistance,
};
