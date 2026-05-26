/**
 * Tests for the PLAN-21 Phase D longitudinal slow-update module.
 *
 * Pure functions (classification, summary, k-means clustering) are tested
 * directly; the DB-touching helpers (`enqueueRegressionPriority`,
 * `lookupBiologicalSnapshot`) exercise an in-memory sqlite with the schema
 * the dream-engine sets up at boot.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import type { GCCRFSnapshot, HormonalSnapshot } from "../agents/skills/interceptor.js";
import type { HeldOutExecution } from "./skill-execution-selection.js";
import {
  bindBiologicalContext,
  classifyOutcome,
  DEFAULT_SLOW_UPDATE_CONFIG,
  enqueueRegressionPriority,
  ensureSlowUpdateSchema,
  lookupBiologicalSnapshot,
  type OutcomeTrajectory,
  readSkillTextHistory,
  runLongitudinalRegression,
  type ScorePairFn,
  shouldRunSlowUpdate,
  snapshotSkillText,
  summarize,
} from "./dream-slow-update.js";

function seededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hormonal(d: number, c: number, o: number): HormonalSnapshot {
  return {
    dopamine: d,
    cortisol: c,
    oxytocin: o,
    response: {
      warmth: 0,
      energy: 0,
      focus: 0,
      playfulness: 0,
      verbosity: 0,
      curiosity: 0,
      assertiveness: 0,
      empathy: 0,
    },
  };
}

function trajectory(
  taskId: string,
  classification: "regression" | "improvement" | "stable-success" | "persistent-failure",
  h: HormonalSnapshot | null,
  g: GCCRFSnapshot | null = null,
): OutcomeTrajectory {
  const priorPassed = classification === "regression" || classification === "stable-success";
  const currentPassed = classification === "improvement" || classification === "stable-success";
  return {
    taskId,
    skillId: "skill-X",
    priorVersion: 1,
    currentVersion: 2,
    priorPassed,
    currentPassed,
    classification,
    hormonal: h,
    gccrf: g,
  };
}

describe("shouldRunSlowUpdate", () => {
  it("fires when interval cycles have elapsed", () => {
    expect(shouldRunSlowUpdate(10, 0)).toBe(true);
  });

  it("does not fire before the interval", () => {
    expect(shouldRunSlowUpdate(9, 0)).toBe(false);
    expect(shouldRunSlowUpdate(5, 0)).toBe(false);
  });

  it("respects a custom interval", () => {
    expect(shouldRunSlowUpdate(15, 10, { ...DEFAULT_SLOW_UPDATE_CONFIG, intervalCycles: 5 })).toBe(
      true,
    );
    expect(shouldRunSlowUpdate(14, 10, { ...DEFAULT_SLOW_UPDATE_CONFIG, intervalCycles: 5 })).toBe(
      false,
    );
  });

  it("returns false for negative cycle counts", () => {
    expect(shouldRunSlowUpdate(-1, 0)).toBe(false);
  });
});

describe("classifyOutcome", () => {
  it("returns the SkillOpt four-way categories", () => {
    expect(classifyOutcome(true, true)).toBe("stable-success");
    expect(classifyOutcome(false, false)).toBe("persistent-failure");
    expect(classifyOutcome(true, false)).toBe("regression");
    expect(classifyOutcome(false, true)).toBe("improvement");
  });
});

describe("summarize", () => {
  it("counts each category", () => {
    const traj: OutcomeTrajectory[] = [
      trajectory("a", "regression", null),
      trajectory("b", "regression", null),
      trajectory("c", "improvement", null),
      trajectory("d", "stable-success", null),
      trajectory("e", "persistent-failure", null),
    ];
    const s = summarize(traj);
    expect(s.regression).toBe(2);
    expect(s.improvement).toBe(1);
    expect(s.stableSuccess).toBe(1);
    expect(s.persistentFailure).toBe(1);
  });

  it("handles an empty input", () => {
    expect(summarize([])).toEqual({
      improvement: 0,
      regression: 0,
      persistentFailure: 0,
      stableSuccess: 0,
    });
  });
});

describe("bindBiologicalContext", () => {
  const cfg = { ...DEFAULT_SLOW_UPDATE_CONFIG, minClusterSize: 2, kHormonal: 2 };

  it("returns empty when fewer regressions than minClusterSize", () => {
    const single = [trajectory("a", "regression", hormonal(0.5, 0.5, 0.5))];
    expect(bindBiologicalContext(single, cfg, seededRng(1))).toEqual([]);
  });

  it("clusters regressions into k buckets separated in hormonal space", () => {
    // Two clearly separated groups: low-cortisol (≈0.2) and high-cortisol (≈0.8)
    const regressions: OutcomeTrajectory[] = [
      trajectory("a1", "regression", hormonal(0.5, 0.2, 0.5)),
      trajectory("a2", "regression", hormonal(0.5, 0.21, 0.5)),
      trajectory("a3", "regression", hormonal(0.5, 0.22, 0.5)),
      trajectory("b1", "regression", hormonal(0.5, 0.8, 0.5)),
      trajectory("b2", "regression", hormonal(0.5, 0.81, 0.5)),
      trajectory("b3", "regression", hormonal(0.5, 0.82, 0.5)),
    ];
    const clusters = bindBiologicalContext(regressions, cfg, seededRng(42));
    expect(clusters.length).toBe(2);
    const cortisols = clusters.map((c) => c.centroid.cortisol).toSorted((a, b) => a - b);
    expect(cortisols[0]).toBeLessThan(0.3);
    expect(cortisols[1]).toBeGreaterThan(0.7);
  });

  it("drops clusters below minClusterSize", () => {
    const regressions: OutcomeTrajectory[] = [
      // 3 close together
      trajectory("a", "regression", hormonal(0.5, 0.2, 0.5)),
      trajectory("b", "regression", hormonal(0.5, 0.2, 0.5)),
      trajectory("c", "regression", hormonal(0.5, 0.2, 0.5)),
      // 1 outlier
      trajectory("z", "regression", hormonal(0.5, 0.95, 0.5)),
    ];
    const clusters = bindBiologicalContext(
      regressions,
      { ...DEFAULT_SLOW_UPDATE_CONFIG, minClusterSize: 3, kHormonal: 2 },
      seededRng(1),
    );
    // Only the tight cluster of 3 survives the minClusterSize filter.
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.members.length).toBe(3);
  });

  it("groups unknown-hormonal regressions into their own cluster when sufficient", () => {
    const regressions: OutcomeTrajectory[] = [
      trajectory("a", "regression", null),
      trajectory("b", "regression", null),
      trajectory("c", "regression", null),
    ];
    const clusters = bindBiologicalContext(
      regressions,
      { ...DEFAULT_SLOW_UPDATE_CONFIG, minClusterSize: 3 },
      seededRng(1),
    );
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.centroid).toEqual({ dopamine: 0, cortisol: 0, oxytocin: 0 });
  });
});

describe("enqueueRegressionPriority + ensureSlowUpdateSchema", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE mutation_queue (
      id TEXT PRIMARY KEY,
      skill_crystal_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      priority REAL DEFAULT 0.5,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      last_attempt_at INTEGER,
      created_at INTEGER NOT NULL
    )`);
    ensureSlowUpdateSchema(db);
  });

  it("adds the context_annotation column idempotently", () => {
    const cols1 = db.prepare(`PRAGMA table_info(mutation_queue)`).all() as Array<{ name: string }>;
    expect(cols1.some((c) => c.name === "context_annotation")).toBe(true);
    ensureSlowUpdateSchema(db); // run again — must not throw
    const cols2 = db.prepare(`PRAGMA table_info(mutation_queue)`).all() as Array<{ name: string }>;
    expect(cols2.length).toBe(cols1.length);
  });

  it("writes a regression-priority row with the cluster annotation", () => {
    const cluster = {
      centroid: { dopamine: 0.4, cortisol: 0.8, oxytocin: 0.3 },
      members: [
        trajectory("a", "regression", hormonal(0.4, 0.8, 0.3)),
        trajectory("b", "regression", hormonal(0.41, 0.81, 0.31)),
        trajectory("c", "regression", hormonal(0.42, 0.82, 0.32)),
      ],
      stats: { meanCortisol: 0.81, meanDopamine: 0.41, size: 3 },
    };
    const result = enqueueRegressionPriority(db, {
      skillId: "skill-Y",
      cluster,
      now: 1700000000000,
    });
    expect(result).not.toBeNull();
    const rows = db
      .prepare(`SELECT * FROM mutation_queue WHERE skill_crystal_id = ?`)
      .all("skill-Y") as Array<{
      id: string;
      strategy: string;
      priority: number;
      context_annotation: string;
    }>;
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.strategy).toBe("regression-priority");
    expect(row.priority).toBeGreaterThan(0.5);
    const annotation = JSON.parse(row.context_annotation) as {
      source: string;
      clusterSize: number;
      centroid: { cortisol: number };
    };
    expect(annotation.source).toBe("plan21-slow-update");
    expect(annotation.clusterSize).toBe(3);
    expect(annotation.centroid.cortisol).toBeCloseTo(0.8, 5);
  });
});

describe("runLongitudinalRegression", () => {
  function execRow(id: string, sessionId: string | null, completedAt: number): HeldOutExecution {
    return {
      id,
      skillId: "skill-X",
      sessionId,
      completedAt,
      success: true,
      rewardScore: 0.5,
      errorType: null,
      contextJson: "{}",
    };
  }

  it("returns empty when no archive versions are supplied", async () => {
    const db = new DatabaseSync(":memory:");
    const scorePair: ScorePairFn = async () => [];
    const out = await runLongitudinalRegression({
      db,
      skillId: "skill-X",
      currentVersion: 5,
      currentSkillText: "current",
      archiveVersions: [],
      selectionSet: [execRow("t1", null, 100)],
      scorePair,
    });
    expect(out).toEqual([]);
  });

  it("returns empty when the selection set is empty", async () => {
    const db = new DatabaseSync(":memory:");
    const scorePair: ScorePairFn = async () => [];
    const out = await runLongitudinalRegression({
      db,
      skillId: "skill-X",
      currentVersion: 5,
      currentSkillText: "current",
      archiveVersions: [{ version: 4, content: "old" }],
      selectionSet: [],
      scorePair,
    });
    expect(out).toEqual([]);
  });

  it("classifies each task per (prior, current) pair into the 4-way taxonomy", async () => {
    const db = new DatabaseSync(":memory:");
    const selectionSet = [
      execRow("t1", null, 100),
      execRow("t2", null, 200),
      execRow("t3", null, 300),
      execRow("t4", null, 400),
    ];
    const scorePair: ScorePairFn = async () => [
      { taskId: "t1", aPassed: true, bPassed: true }, // stable-success
      { taskId: "t2", aPassed: true, bPassed: false }, // regression
      { taskId: "t3", aPassed: false, bPassed: true }, // improvement
      { taskId: "t4", aPassed: false, bPassed: false }, // persistent-failure
    ];
    const out = await runLongitudinalRegression({
      db,
      skillId: "skill-X",
      currentVersion: 2,
      currentSkillText: "current",
      archiveVersions: [{ version: 1, content: "old" }],
      selectionSet,
      scorePair,
    });
    expect(out.length).toBe(4);
    const summary = summarize(out);
    expect(summary.stableSuccess).toBe(1);
    expect(summary.regression).toBe(1);
    expect(summary.improvement).toBe(1);
    expect(summary.persistentFailure).toBe(1);
  });

  it("iterates each archive version and tags trajectories with the right priorVersion", async () => {
    const db = new DatabaseSync(":memory:");
    const selectionSet = [execRow("t1", null, 100)];
    const scorePair: ScorePairFn = async (_a, _b, set) =>
      set.map((s) => ({ taskId: s.id, aPassed: true, bPassed: true }));
    const out = await runLongitudinalRegression({
      db,
      skillId: "skill-X",
      currentVersion: 5,
      currentSkillText: "current",
      archiveVersions: [
        { version: 4, content: "v4" },
        { version: 3, content: "v3" },
        { version: 2, content: "v2" },
      ],
      selectionSet,
      scorePair,
    });
    expect(out.length).toBe(3);
    const versions = out.map((t) => t.priorVersion).toSorted((a, b) => a - b);
    expect(versions).toEqual([2, 3, 4]);
    expect(out.every((t) => t.currentVersion === 5)).toBe(true);
  });
});

describe("skill_text_history snapshot + read", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE mutation_queue (
      id TEXT PRIMARY KEY, skill_crystal_id TEXT NOT NULL, strategy TEXT NOT NULL,
      priority REAL DEFAULT 0.5, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3,
      last_attempt_at INTEGER, created_at INTEGER NOT NULL
    )`);
    ensureSlowUpdateSchema(db);
  });

  it("snapshots a prior version and reads it back", () => {
    expect(
      snapshotSkillText(db, {
        skillId: "skill-A",
        version: 1,
        text: "original text",
        promotedAt: 1000,
      }),
    ).toBe(true);
    const history = readSkillTextHistory(db, "skill-A", 5);
    expect(history.length).toBe(1);
    expect(history[0]).toEqual({ version: 1, content: "original text" });
  });

  it("is idempotent on (skill_id, version)", () => {
    snapshotSkillText(db, {
      skillId: "skill-A",
      version: 1,
      text: "first",
      promotedAt: 1000,
    });
    const second = snapshotSkillText(db, {
      skillId: "skill-A",
      version: 1,
      text: "DIFFERENT — should be ignored",
      promotedAt: 2000,
    });
    expect(second).toBe(true); // operation succeeded
    const history = readSkillTextHistory(db, "skill-A", 5);
    expect(history.length).toBe(1);
    expect(history[0]?.content).toBe("first");
  });

  it("returns versions newest first up to the depth limit", () => {
    for (let v = 1; v <= 5; v++) {
      snapshotSkillText(db, {
        skillId: "skill-A",
        version: v,
        text: `v${v}`,
        promotedAt: 1000 + v,
      });
    }
    const top3 = readSkillTextHistory(db, "skill-A", 3);
    expect(top3.map((h) => h.version)).toEqual([5, 4, 3]);
  });

  it("returns [] for unknown skill or zero depth", () => {
    expect(readSkillTextHistory(db, "missing", 5)).toEqual([]);
    snapshotSkillText(db, { skillId: "skill-A", version: 1, text: "x", promotedAt: 1 });
    expect(readSkillTextHistory(db, "skill-A", 0)).toEqual([]);
  });
});

describe("lookupBiologicalSnapshot", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE intervention_records (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      skill TEXT NOT NULL,
      interceptor_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      intervention_type TEXT NOT NULL,
      action_original_json TEXT NOT NULL,
      action_final_json TEXT,
      intervention_json TEXT NOT NULL,
      state_summary_json TEXT NOT NULL,
      activation_latency_ms REAL DEFAULT 0,
      intervention_latency_ms REAL DEFAULT 0,
      outcome_tag TEXT,
      outcome_evidence TEXT,
      ed25519_sig TEXT DEFAULT '',
      pubkey_id TEXT DEFAULT 'unsigned-local',
      record_json TEXT NOT NULL
    )`);
  });

  function insertRec(args: {
    id: string;
    ts: number;
    skill: string;
    session: string;
    state: object;
  }) {
    db.prepare(
      `INSERT INTO intervention_records (
         id, ts, session_key, skill, interceptor_id, channel, tool_name,
         intervention_type, action_original_json, intervention_json,
         state_summary_json, record_json
       ) VALUES (?, ?, ?, ?, 'ic1', 'internal', 'send', 'modify', '{}', '{}', ?, '{}')`,
    ).run(args.id, args.ts, args.session, args.skill, JSON.stringify(args.state));
  }

  it("returns the hormonal + gccrf snapshot from the matching record", () => {
    const h = hormonal(0.3, 0.7, 0.5);
    const g: GCCRFSnapshot = {
      predictionError: 0.2,
      learningProgress: 0.1,
      novelty: 0.4,
      empowerment: 0.6,
      strategicAlignment: 0.5,
      certaintyDelta: 0.05,
    };
    insertRec({
      id: "r1",
      ts: 100,
      skill: "skill-A",
      session: "sess-1",
      state: { hormonal: h, gccrf: g, channel: "internal" },
    });
    const out = lookupBiologicalSnapshot(db, {
      skillId: "skill-A",
      sessionKey: "sess-1",
      beforeTs: 200,
    });
    expect(out.hormonal?.cortisol).toBe(0.7);
    expect(out.gccrf?.novelty).toBe(0.4);
  });

  it("returns null hormonal when no record matches", () => {
    const out = lookupBiologicalSnapshot(db, {
      skillId: "missing",
      sessionKey: "x",
      beforeTs: 0,
    });
    expect(out.hormonal).toBeNull();
    expect(out.gccrf).toBeNull();
  });

  it("returns the most recent record before the cutoff", () => {
    insertRec({
      id: "r1",
      ts: 100,
      skill: "skill-A",
      session: "sess-1",
      state: { hormonal: hormonal(0.1, 0.1, 0.1) },
    });
    insertRec({
      id: "r2",
      ts: 200,
      skill: "skill-A",
      session: "sess-1",
      state: { hormonal: hormonal(0.9, 0.9, 0.9) },
    });
    insertRec({
      id: "r3",
      ts: 300,
      skill: "skill-A",
      session: "sess-1",
      state: { hormonal: hormonal(0.5, 0.5, 0.5) },
    });
    // Asking for "before 250" should pick r2, not r3.
    const out = lookupBiologicalSnapshot(db, {
      skillId: "skill-A",
      sessionKey: "sess-1",
      beforeTs: 250,
    });
    expect(out.hormonal?.cortisol).toBeCloseTo(0.9, 5);
  });
});
