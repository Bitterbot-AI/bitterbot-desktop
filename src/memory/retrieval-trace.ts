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
};

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

  constructor(private readonly window = 200) {}

  /** Feed one retrieval's per-layer contribution counts. */
  record(counts: Record<string, number>): void {
    this.total += 1;
    for (const [layer, n] of Object.entries(counts)) {
      this.sinceContribution.set(layer, n > 0 ? 0 : (this.sinceContribution.get(layer) ?? 0) + 1);
    }
  }

  /**
   * Return any layer dead for a full window while the system is otherwise
   * active. Stateful: a returned warning is suppressed for the next `window`
   * retrievals so the maintenance cycle doesn't re-log it every tick.
   */
  checkDeadWires(): DeadWireWarning[] {
    if (this.total < this.window) {
      return [];
    }
    const layers = [...this.sinceContribution.keys()];
    // "System otherwise active" — at least one layer fired within the window.
    const systemActive = layers.some((l) => (this.sinceContribution.get(l) ?? 0) < this.window);
    if (!systemActive) {
      return [];
    }
    const out: DeadWireWarning[] = [];
    for (const layer of layers) {
      const since = this.sinceContribution.get(layer) ?? 0;
      if (since < this.window) {
        continue;
      }
      const lastWarn = this.lastWarnedAt.get(layer) ?? -Infinity;
      if (this.total - lastWarn < this.window) {
        continue;
      }
      this.lastWarnedAt.set(layer, this.total);
      out.push({ layer, searchesSinceContribution: since, window: this.window });
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
      log.warn(
        `retrieval layer "${w.layer}" contributed 0 over the last ${w.searchesSinceContribution} ` +
          `retrievals (window ${w.window}) while other layers fired — populated/wired?`,
      );
    }
    return warnings;
  }
}
