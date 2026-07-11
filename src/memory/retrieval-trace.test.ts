import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  emptyRecallCounts,
  emptySearchCounts,
  recordRetrievalTrace,
  resolveTraceSampleRate,
  RetrievalObservability,
  TIME_WINDOW_MIN_ACTIVITY,
  type DeadLaneStateStore,
} from "./retrieval-trace.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Creates meta/files/chunks/... and runs all migrations (incl. v21 retrieval_trace).
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

describe("RetrievalObservability dead-wire detector (PLAN-28 B3)", () => {
  it("fires for a layer that is 0 across a full window while others fire", () => {
    const obs = new RetrievalObservability(50);
    for (let i = 0; i < 50; i++) {
      // vector + keyword fire every retrieval; graph never does.
      obs.record({ vector: 3, keyword: 2, graph: 0 });
    }
    const warnings = obs.checkDeadWires();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.layer).toBe("graph");
    expect(warnings[0]!.searchesSinceContribution).toBeGreaterThanOrEqual(50);
  });

  it("does NOT fire before the window warms up", () => {
    const obs = new RetrievalObservability(50);
    for (let i = 0; i < 10; i++) {
      obs.record({ vector: 1, graph: 0 });
    }
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("does NOT fire when the system is entirely idle (all layers 0)", () => {
    const obs = new RetrievalObservability(20);
    for (let i = 0; i < 30; i++) {
      obs.record({ vector: 0, keyword: 0, graph: 0 });
    }
    // No layer fired — can't distinguish "dead wire" from "no traffic".
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("clears the alarm once the layer starts contributing", () => {
    const obs = new RetrievalObservability(20);
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, graph: 0 });
    }
    expect(obs.checkDeadWires()).toHaveLength(1);
    // Graph comes alive.
    for (let i = 0; i < 5; i++) {
      obs.record({ vector: 1, graph: 2 });
    }
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("dedupes repeated warnings within a window", () => {
    const obs = new RetrievalObservability(20);
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, graph: 0 });
    }
    expect(obs.warnDeadWires()).toHaveLength(1);
    // Immediately checking again must not re-warn for the same dead layer.
    obs.record({ vector: 1, graph: 0 });
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("snapshot exposes counters for the telemetry surface (B4)", () => {
    const obs = new RetrievalObservability(20);
    obs.record({ vector: 1, graph: 0 });
    const snap = obs.snapshot();
    expect(snap.total).toBe(1);
    expect(snap.sinceContribution.vector).toBe(0);
    expect(snap.sinceContribution.graph).toBe(1);
  });
});

describe("time-window dead-lane checks for low-frequency lanes (PLAN-34 Phase 6 §8)", () => {
  const DAY = 86_400_000;
  const THIRTY_DAYS = 30 * DAY;

  function clockAt(start: number) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("a time-window lane does NOT false-alarm after a full rolling window of zeros", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    // 25 retrievals in one day: open_loops legitimately 0 (no unfinished work).
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, open_loops: 0 });
      clock.advance(1000);
    }
    // The rolling check would have flagged open_loops here; the time window must not.
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("fires once the lane has been silent for the full time window", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    obs.record({ vector: 1, open_loops: 1 }); // fired once at t0
    for (let i = 0; i < 31; i++) {
      clock.advance(DAY);
      obs.record({ vector: 1, open_loops: 0 });
    }
    const warnings = obs.checkDeadWires();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.layer).toBe("open_loops");
    expect(warnings[0]!.kind).toBe("time_window");
    expect(warnings[0]!.daysSinceContribution).toBeGreaterThanOrEqual(30);
  });

  it("a never-fired lane is measured from first observation, not from epoch", () => {
    const clock = clockAt(5_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, open_loops: 0 });
      clock.advance(1000);
    }
    // Observed for well under 30 days — silent-from-birth is not yet an alarm.
    expect(obs.checkDeadWires()).toEqual([]);
    clock.advance(THIRTY_DAYS + DAY);
    obs.record({ vector: 1, open_loops: 0 });
    expect(obs.checkDeadWires().some((w) => w.layer === "open_loops")).toBe(true);
  });

  it("a contribution resets the time window", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, open_loops: 0 });
      clock.advance(1000);
    }
    clock.advance(29 * DAY);
    obs.record({ vector: 1, open_loops: 2 }); // fires just before the window closes
    clock.advance(2 * DAY);
    obs.record({ vector: 1, open_loops: 0 });
    expect(obs.checkDeadWires()).toEqual([]);
  });

  it("re-warns are suppressed for a full time window", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    obs.record({ vector: 1, open_loops: 1 });
    for (let i = 0; i < 31; i++) {
      clock.advance(DAY);
      obs.record({ vector: 1, open_loops: 0 });
    }
    expect(obs.checkDeadWires()).toHaveLength(1);
    clock.advance(DAY);
    obs.record({ vector: 1, open_loops: 0 });
    expect(obs.checkDeadWires()).toEqual([]); // suppressed
    clock.advance(THIRTY_DAYS);
    obs.record({ vector: 1, open_loops: 0 });
    expect(obs.checkDeadWires()).toHaveLength(1); // next 30-day epoch re-warns
  });

  it("rolling lanes still warn with kind='rolling' alongside a healthy time lane", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    for (let i = 0; i < 25; i++) {
      obs.record({ vector: 1, graph: 0, open_loops: 0 });
      clock.advance(1000);
    }
    const warnings = obs.checkDeadWires();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.layer).toBe("graph");
    expect(warnings[0]!.kind).toBe("rolling");
  });

  it("idle-system regression: traffic then a month of pure silence never warns", () => {
    // Adversarial pass: wall-clock silence with frozen counters must never
    // read as a dead lane — the process was idle, nothing COULD fire.
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    obs.record({ vector: 1, open_loops: 1 });
    for (let i = 0; i < 30; i++) {
      clock.advance(1000);
      obs.record({ vector: 1, open_loops: 0 });
    }
    clock.advance(31 * DAY); // agent idle; maintenance timer still ticks
    expect(obs.checkDeadWires()).toEqual([]);
    expect(obs.deadWiresSnapshot()).toEqual([]);
  });

  it("a single post-idle retrieval is not evidence — needs TIME_WINDOW_MIN_ACTIVITY active records", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    obs.record({ vector: 1, open_loops: 1 });
    clock.advance(31 * DAY);
    obs.record({ vector: 1, open_loops: 0 }); // system resumes
    expect(obs.checkDeadWires()).toEqual([]);
    for (let i = 0; i < TIME_WINDOW_MIN_ACTIVITY; i++) {
      clock.advance(1000);
      obs.record({ vector: 1, open_loops: 0 });
    }
    expect(obs.checkDeadWires().some((w) => w.layer === "open_loops")).toBe(true);
  });

  it("time lanes are evaluated below the rolling warm-up (low-traffic deployments)", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(200, { open_loops: THIRTY_DAYS }, clock.now);
    obs.record({ vector: 1, open_loops: 1 });
    // ~31 total records (far under the 200-call warm-up), spread over 45 days.
    for (let i = 0; i < 30; i++) {
      clock.advance(1.5 * DAY);
      obs.record({ vector: 1, open_loops: 0 });
    }
    const warnings = obs.checkDeadWires();
    expect(warnings.some((w) => w.layer === "open_loops" && w.kind === "time_window")).toBe(true);
  });

  it("deadWiresSnapshot is pure: the dashboard sees the fault on every poll", () => {
    const clock = clockAt(1_000_000);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now);
    obs.record({ vector: 1, open_loops: 1 });
    for (let i = 0; i < 31; i++) {
      clock.advance(DAY);
      obs.record({ vector: 1, open_loops: 0 });
    }
    expect(obs.deadWiresSnapshot()).toHaveLength(1);
    expect(obs.deadWiresSnapshot()).toHaveLength(1); // repeated polls unaffected
    expect(obs.checkDeadWires()).toHaveLength(1); // maintenance log warns once
    expect(obs.checkDeadWires()).toEqual([]); // …then dedupes
    expect(obs.deadWiresSnapshot()).toHaveLength(1); // view NOT blinded by log dedupe
  });

  it("lane baselines persist across restart via the state store", () => {
    const backing = new Map<string, number>();
    const store: DeadLaneStateStore = {
      get: (k) => backing.get(k) ?? null,
      set: (k, v) => void backing.set(k, v),
    };
    const clock = clockAt(1_000_000);
    const obs1 = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now, store);
    obs1.record({ vector: 1, open_loops: 1 }); // persists the lane's last fire
    clock.advance(31 * DAY);

    // "Restart": a fresh instance over the same store must NOT re-baseline.
    const obs2 = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now, store);
    for (let i = 0; i <= TIME_WINDOW_MIN_ACTIVITY; i++) {
      clock.advance(1000);
      obs2.record({ vector: 1, open_loops: 0 });
    }
    const warnings = obs2.checkDeadWires();
    expect(
      warnings.some((w) => w.layer === "open_loops" && (w.daysSinceContribution ?? 0) >= 30),
    ).toBe(true);

    // The warn timestamp also persisted: another restart stays suppressed.
    const obs3 = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now, store);
    for (let i = 0; i <= TIME_WINDOW_MIN_ACTIVITY; i++) {
      clock.advance(1000);
      obs3.record({ vector: 1, open_loops: 0 });
    }
    expect(obs3.checkDeadWires()).toEqual([]);
  });

  it("a throwing store defers hydration instead of silently re-baselining", () => {
    const backing = new Map<string, number>([["deadlane_last_fire_open_loops", 1_000_000]]);
    let ready = false;
    const store: DeadLaneStateStore = {
      get: (k) => {
        if (!ready) {
          throw new Error("db not ready");
        }
        return backing.get(k) ?? null;
      },
      set: (k, v) => {
        if (!ready) {
          throw new Error("db not ready");
        }
        backing.set(k, v);
      },
    };
    const clock = clockAt(1_000_000 + 31 * DAY);
    const obs = new RetrievalObservability(20, { open_loops: THIRTY_DAYS }, clock.now, store);
    obs.record({ vector: 1, open_loops: 0 }); // hydrate fails, retried later
    ready = true;
    for (let i = 0; i < TIME_WINDOW_MIN_ACTIVITY + 1; i++) {
      clock.advance(1000);
      obs.record({ vector: 1, open_loops: 0 });
    }
    // Hydration succeeded on a later call: the 31-day-old persisted baseline
    // (not a fresh firstSeen) drives the warning.
    expect(obs.checkDeadWires().some((w) => w.layer === "open_loops")).toBe(true);
  });
});

describe("recordRetrievalTrace (PLAN-28 B2)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it("writes a sampled search trace row at rate 1", () => {
    const counts = {
      ...emptySearchCounts(),
      vectorHits: 4,
      keywordHits: 2,
      graphHits: 1,
      fused: 5,
    };
    recordRetrievalTrace(db, "search", counts, { queryLen: 12, sampleRate: 1 });
    const row = db
      .prepare(
        `SELECT kind, vector_hits, keyword_hits, graph_hits, fused, extra FROM retrieval_trace`,
      )
      .get() as Record<string, unknown>;
    expect(row.kind).toBe("search");
    expect(row.vector_hits).toBe(4);
    expect(row.graph_hits).toBe(1);
    expect(row.fused).toBe(5);
    expect(JSON.parse(row.extra as string).temporalIntent).toBe("timeless");
  });

  it("never writes at rate 0", () => {
    recordRetrievalTrace(db, "search", emptySearchCounts(), { queryLen: 1, sampleRate: 0 });
    const n = db.prepare(`SELECT COUNT(*) AS c FROM retrieval_trace`).get() as { c: number };
    expect(n.c).toBe(0);
  });

  it("maps recall layer counts onto the trace columns", () => {
    const counts = { ...emptyRecallCounts(), graphFacts: 2, vectorFacts: 1, openLoops: 1 };
    recordRetrievalTrace(db, "recall", counts, { queryLen: 8, sampleRate: 1 });
    const row = db
      .prepare(`SELECT kind, vector_hits, graph_hits, fused FROM retrieval_trace`)
      .get() as Record<string, unknown>;
    expect(row.kind).toBe("recall");
    expect(row.vector_hits).toBe(1);
    expect(row.graph_hits).toBe(2);
    expect(row.fused).toBe(4); // 2 + 0 identity + 1 + 1
  });
});

describe("resolveTraceSampleRate", () => {
  const prev = process.env.BITTERBOT_RETRIEVAL_TRACE_RATE;
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.BITTERBOT_RETRIEVAL_TRACE_RATE;
    } else {
      process.env.BITTERBOT_RETRIEVAL_TRACE_RATE = prev;
    }
  });

  it("defaults to an active rate when unset", () => {
    delete process.env.BITTERBOT_RETRIEVAL_TRACE_RATE;
    expect(resolveTraceSampleRate()).toBeGreaterThan(0);
  });
  it("honours an explicit 0 (off)", () => {
    process.env.BITTERBOT_RETRIEVAL_TRACE_RATE = "0";
    expect(resolveTraceSampleRate()).toBe(0);
  });
  it("clamps out-of-range values", () => {
    process.env.BITTERBOT_RETRIEVAL_TRACE_RATE = "5";
    expect(resolveTraceSampleRate()).toBe(1);
  });
});
