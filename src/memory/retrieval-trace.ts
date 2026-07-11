/**
 * PLAN-28 Part B — retrieval observability.
 *
 * Two complementary instruments over the multi-layer retrieval path, built so a
 * silently dead layer (the recurring "wired but dead" defect class) can never
 * hide again:
 *
 *   B2 — a sampled, persisted `retrieval_trace` row recording each layer's
 *        contribution for offline "is each layer pulling its weight" analysis
 *        and before/after ablations. Modeled on `recordDreamTelemetry`.
 *
 *   B3 — an in-process, rolling dead-wire detector: if a layer contributes 0
 *        across N consecutive retrievals while the system is otherwise active
 *        (other layers ARE firing), it raises a warning. Cheap counters, no
 *        hot-path cost; surfaced through the maintenance cycle (B4).
 *
 * Span attributes (B1) are attached at the call site via `withSpanAttrs`; this
 * module owns the persisted trace + the detector so manager.ts stays thin.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/retrieval-trace");

/** Per-layer counts for a single hybrid `memory.search`. */
export type SearchLayerCounts = {
  vectorHits: number;
  keywordHits: number;
  graphHits: number;
  fused: number;
  moodBoostApplied: number;
  temporalIntent: string;
};

/** Per-layer counts for a single proactive `memory.recall` turn. */
export type RecallLayerCounts = {
  graphFacts: number;
  identityFacts: number;
  vectorFacts: number;
  /**
   * Crystals surfaced by the FTS keyword fallback that runs when the query
   * embedding is unavailable (cold-process timeout, provider down). Folded
   * into the `vector` dead-wire lane by the caller — it is the same semantic
   * crystal channel, just a degraded transport — but counted separately here
   * so traces show how often recall is running degraded.
   */
  keywordFacts: number;
  openLoops: number;
};

export function emptySearchCounts(): SearchLayerCounts {
  return {
    vectorHits: 0,
    keywordHits: 0,
    graphHits: 0,
    fused: 0,
    moodBoostApplied: 0,
    temporalIntent: "timeless",
  };
}

export function emptyRecallCounts(): RecallLayerCounts {
  return { graphFacts: 0, identityFacts: 0, vectorFacts: 0, keywordFacts: 0, openLoops: 0 };
}

/** Resolve the persisted-trace sampling rate (0 disables). Default 0.05. */
export function resolveTraceSampleRate(): number {
  const raw = process.env.BITTERBOT_RETRIEVAL_TRACE_RATE;
  if (raw === undefined || raw === "") {
    return 0.05;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return 0.05;
  }
  return Math.max(0, Math.min(1, n));
}

/**
 * Write a sampled retrieval trace row. Best-effort: the table may not exist yet
 * during early init, and a trace write must never break retrieval. `sampleRate`
 * 0 disables; 1 records every call. Sampling is decided here so callers stay
 * trivial.
 */
export function recordRetrievalTrace(
  db: DatabaseSync,
  kind: "search" | "recall",
  counts: SearchLayerCounts | RecallLayerCounts,
  opts: { queryLen: number; sampleRate: number },
): void {
  if (opts.sampleRate <= 0 || Math.random() >= opts.sampleRate) {
    return;
  }
  try {
    const isSearch = "vectorHits" in counts;
    const vectorHits = isSearch ? counts.vectorHits : counts.vectorFacts;
    const keywordHits = isSearch ? counts.keywordHits : counts.keywordFacts;
    const graphHits = isSearch ? counts.graphHits : counts.graphFacts;
    const fused = isSearch
      ? counts.fused
      : counts.graphFacts +
        counts.identityFacts +
        counts.vectorFacts +
        counts.keywordFacts +
        counts.openLoops;
    db.prepare(
      `INSERT INTO retrieval_trace
         (kind, query_len, vector_hits, keyword_hits, graph_hits, fused, extra, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      kind,
      opts.queryLen,
      vectorHits,
      keywordHits,
      graphHits,
      fused,
      JSON.stringify(counts),
      Date.now(),
    );
  } catch {
    // Trace persistence is non-critical and must not affect retrieval.
  }
}

/** A layer the detector watches, plus how long since it last contributed. */
export type DeadWireWarning = {
  layer: string;
  searchesSinceContribution: number;
  window: number;
  /**
   * PLAN-34 Phase 6 (§8): set for time-window lanes — how many days the lane
   * has gone without contributing (the rolling counter fields above are
   * still populated but the TIME is what tripped the alarm).
   */
  daysSinceContribution?: number;
  kind?: "rolling" | "time_window";
};

/** PLAN-34 Phase 6 (§8): default time window for low-frequency lanes. */
export const TIME_WINDOW_LANE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * PLAN-34 Phase 6 (§8): minimum SYSTEM-ACTIVE retrievals (records where some
 * lane contributed) that must occur after a time-window lane's last fire
 * before it may warn. Wall-clock silence alone cannot distinguish "lane
 * dead" from "process idle for a month" — this gate proves other lanes were
 * genuinely firing during the silence. In-memory (resets per process), so
 * it doubles as a small post-restart warm-up against noise.
 */
export const TIME_WINDOW_MIN_ACTIVITY = 25;

/**
 * PLAN-34 Phase 6 (§8): optional persistence for time-window lane state.
 * A 30-day check kept only in memory is neutered by any restart cadence
 * under 30 days, so lane baselines (last fire, first seen, last warn)
 * round-trip through this store. Implementations must throw on an
 * unavailable backing store — the detector treats that as "not hydrated
 * yet" and retries, never silently re-baselining.
 */
export interface DeadLaneStateStore {
  get(key: string): number | null;
  set(key: string, value: number): void;
}

/**
 * PLAN-28 B3: rolling per-layer contribution counter and dead-wire detector.
 *
 * One instance lives on the memory manager. Each retrieval feeds per-layer
 * counts; a layer that contributes 0 across `window` consecutive retrievals —
 * while at least one *other* layer is still firing, proving the system is
 * actively retrieving rather than idle — is flagged. This single check would
 * have caught all three "wired but dead" defects from the PLAN-27/28 session
 * (null query embedding, the uncalled live-stimulation, the empty graph layer).
 *
 * Deliberately does NOT require a layer to have "ever contributed": the empty
 * graph layer is precisely the case we want surfaced, and it has contributed
 * exactly zero from birth.
 */
export class RetrievalObservability {
  /** Consecutive retrievals (search+recall combined) since each layer last fired. */
  private readonly sinceContribution = new Map<string, number>();
  /** Total retrievals observed across all layers (for warm-up gating). */
  private total = 0;
  /** Last total at which we warned for a layer, to dedupe spammy warnings. */
  private readonly lastWarnedAt = new Map<string, number>();
  /** PLAN-34 §8: wall-clock of each lane's last nonzero contribution. */
  private readonly lastContributionAt = new Map<string, number>();
  /** PLAN-34 §8: when each lane was first observed (baseline for never-fired lanes). */
  private readonly firstSeenAt = new Map<string, number>();
  /** PLAN-34 §8: wall-clock of the last warning per time-window lane. */
  private readonly lastTimeWarnAt = new Map<string, number>();
  /** PLAN-34 §8: count of records where SOME lane contributed (system truly active). */
  private activityCount = 0;
  /** PLAN-34 §8: wall-clock of the most recent record where some lane contributed. */
  private lastActivityAt: number | null = null;
  /** PLAN-34 §8: activityCount snapshot at each time lane's last fire (or 0). */
  private readonly activityAtLaneFire = new Map<string, number>();
  /** PLAN-34 §8: whether persisted lane state has been loaded yet. */
  private hydrated = false;

  /**
   * `timeWindowLanes` (PLAN-34 Phase 6 §8) maps LOW-FREQUENCY lane names to a
   * time window in ms: those lanes are judged by "no contribution for this
   * long while the system was actively retrieving" instead of the rolling
   * call-count window. A lane like open_loops legitimately contributes 0
   * across hundreds of retrievals whenever no unfinished work exists —
   * under the rolling check it would false-alarm weekly-cadence lanes into
   * alarm blindness. `stateStore` persists those lanes' baselines across
   * restarts (a 30-day clock reset by every restart would never fire).
   */
  constructor(
    private readonly window = 200,
    private readonly timeWindowLanes: Record<string, number> = {},
    private readonly now: () => number = Date.now,
    private readonly stateStore?: DeadLaneStateStore,
  ) {}

  /** Load persisted time-lane baselines once; retry later if the store isn't ready. */
  private hydrate(): void {
    if (this.hydrated) {
      return;
    }
    if (!this.stateStore) {
      this.hydrated = true;
      return;
    }
    try {
      for (const layer of Object.keys(this.timeWindowLanes)) {
        const fired = this.stateStore.get(`deadlane_last_fire_${layer}`);
        if (fired !== null && !this.lastContributionAt.has(layer)) {
          this.lastContributionAt.set(layer, fired);
        }
        const seen = this.stateStore.get(`deadlane_first_seen_${layer}`);
        if (seen !== null && !this.firstSeenAt.has(layer)) {
          this.firstSeenAt.set(layer, seen);
        }
        const warned = this.stateStore.get(`deadlane_last_warn_${layer}`);
        if (warned !== null && !this.lastTimeWarnAt.has(layer)) {
          this.lastTimeWarnAt.set(layer, warned);
        }
      }
      this.hydrated = true;
    } catch {
      // Store not ready (early init) — retry on the next call rather than
      // silently re-baselining a 30-day clock.
    }
  }

  private persistLane(key: string, value: number): void {
    try {
      this.stateStore?.set(key, value);
    } catch {
      // Best-effort; the in-memory state remains authoritative this process.
    }
  }

  /** Feed one retrieval's per-layer contribution counts. */
  record(counts: Record<string, number>): void {
    this.hydrate();
    this.total += 1;
    const at = this.now();
    if (Object.values(counts).some((n) => n > 0)) {
      this.activityCount += 1;
      this.lastActivityAt = at;
    }
    for (const [layer, n] of Object.entries(counts)) {
      const isTimeLane = this.timeWindowLanes[layer] !== undefined;
      if (!this.firstSeenAt.has(layer)) {
        this.firstSeenAt.set(layer, at);
        if (isTimeLane) {
          this.persistLane(`deadlane_first_seen_${layer}`, at);
        }
      }
      if (n > 0) {
        this.lastContributionAt.set(layer, at);
        this.activityAtLaneFire.set(layer, this.activityCount);
        if (isTimeLane) {
          this.persistLane(`deadlane_last_fire_${layer}`, at);
        }
      }
      this.sinceContribution.set(layer, n > 0 ? 0 : (this.sinceContribution.get(layer) ?? 0) + 1);
    }
  }

  /**
   * Pure evaluation of every dead lane — NO suppression state is touched.
   * View surfaces (retrievalHealth → dashboard) call this via
   * deadWiresSnapshot() so a persistent fault stays visible on every poll;
   * only the consuming checkDeadWires() advances warn-dedupe state.
   */
  private evaluateDeadWires(at: number): DeadWireWarning[] {
    this.hydrate();
    const out: DeadWireWarning[] = [];

    // Time-window lanes (PLAN-34 §8): three conditions, ALL required —
    //   1. lane silent for the full wall-clock window;
    //   2. the system contributed RECENTLY (an idle process — traffic then a
    //      month of nothing — must never warn off pure wall-clock);
    //   3. enough system-active records since the lane last fired (a single
    //      post-idle retrieval is not evidence the lane is dead).
    for (const [layer, timeWindowMs] of Object.entries(this.timeWindowLanes)) {
      const baseline = this.lastContributionAt.get(layer) ?? this.firstSeenAt.get(layer);
      if (baseline === undefined) {
        continue; // never observed
      }
      const silentMs = at - baseline;
      if (silentMs < timeWindowMs) {
        continue;
      }
      if (this.lastActivityAt === null || at - this.lastActivityAt >= timeWindowMs) {
        continue; // system itself has been idle — not a dead lane
      }
      const activeSinceFire = this.activityCount - (this.activityAtLaneFire.get(layer) ?? 0);
      if (activeSinceFire < TIME_WINDOW_MIN_ACTIVITY) {
        continue;
      }
      out.push({
        layer,
        searchesSinceContribution: this.sinceContribution.get(layer) ?? 0,
        window: this.window,
        daysSinceContribution: Math.floor(silentMs / 86_400_000),
        kind: "time_window",
      });
    }

    // Rolling lanes (PLAN-28 B3), unchanged semantics.
    if (this.total < this.window) {
      return out;
    }
    const layers = [...this.sinceContribution.keys()];
    // "System otherwise active" — at least one layer fired within the window.
    const systemActive = layers.some((l) => (this.sinceContribution.get(l) ?? 0) < this.window);
    if (!systemActive) {
      return out;
    }
    for (const layer of layers) {
      if (this.timeWindowLanes[layer] !== undefined) {
        continue; // judged above
      }
      const since = this.sinceContribution.get(layer) ?? 0;
      if (since < this.window) {
        continue;
      }
      out.push({ layer, searchesSinceContribution: since, window: this.window, kind: "rolling" });
    }
    return out;
  }

  /**
   * Side-effect-free view of currently dead lanes, for retrievalHealth and
   * the dashboard: a genuinely dead lane renders on EVERY poll instead of
   * being consumed by the first reader.
   */
  deadWiresSnapshot(): DeadWireWarning[] {
    return this.evaluateDeadWires(this.now());
  }

  /**
   * Return any layer dead for a full window while the system is otherwise
   * active. Stateful — for the maintenance LOG path only: a returned warning
   * is suppressed for the next `window` retrievals (rolling) or a full time
   * window (time lanes) so the cycle doesn't re-log it every tick.
   */
  checkDeadWires(): DeadWireWarning[] {
    const at = this.now();
    const out: DeadWireWarning[] = [];
    for (const w of this.evaluateDeadWires(at)) {
      if (w.kind === "time_window") {
        const timeWindowMs = this.timeWindowLanes[w.layer] ?? 0;
        const lastWarn = this.lastTimeWarnAt.get(w.layer) ?? -Infinity;
        if (at - lastWarn < timeWindowMs) {
          continue;
        }
        this.lastTimeWarnAt.set(w.layer, at);
        this.persistLane(`deadlane_last_warn_${w.layer}`, at);
      } else {
        const lastWarn = this.lastWarnedAt.get(w.layer) ?? -Infinity;
        if (this.total - lastWarn < this.window) {
          continue;
        }
        this.lastWarnedAt.set(w.layer, this.total);
      }
      out.push(w);
    }
    return out;
  }

  /** Snapshot for the management/telemetry surface (B4). */
  snapshot(): { total: number; sinceContribution: Record<string, number> } {
    return {
      total: this.total,
      sinceContribution: Object.fromEntries(this.sinceContribution),
    };
  }

  /** Run the detector and log a warning per dead layer. Called from maintenance. */
  warnDeadWires(): DeadWireWarning[] {
    const warnings = this.checkDeadWires();
    for (const w of warnings) {
      if (w.kind === "time_window") {
        log.warn(
          `retrieval lane "${w.layer}" has not contributed for ${w.daysSinceContribution} day(s) ` +
            `while other layers fired — populated/wired?`,
        );
      } else {
        log.warn(
          `retrieval layer "${w.layer}" contributed 0 over the last ${w.searchesSinceContribution} ` +
            `retrievals (window ${w.window}) while other layers fired — populated/wired?`,
        );
      }
    }
    return warnings;
  }
}
