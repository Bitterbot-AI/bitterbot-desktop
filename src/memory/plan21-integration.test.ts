/**
 * Integration tests across PLAN-21 modules. Exercise multi-module flows
 * that the per-module suites can't cover on their own:
 *
 *   - End-to-end slow-update: runLongitudinalRegression → bindBiologicalContext →
 *     enqueueRegressionPriority, verified through SQLite state.
 *   - Bootstrap CI bound properties on synthetic paired data.
 *   - skill_text_history bytes-exact preservation (no Unicode truncation).
 *   - scoreVersionPair determinism on a stubbed llmCall.
 *   - Selection-set stability under DB churn.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import type { HormonalSnapshot } from "../agents/skills/interceptor.js";
import {
  bindBiologicalContext,
  classifyOutcome,
  DEFAULT_SLOW_UPDATE_CONFIG,
  enqueueRegressionPriority,
  ensureSlowUpdateSchema,
  readSkillTextHistory,
  runLongitudinalRegression,
  type ScorePairFn,
  snapshotSkillText,
} from "./dream-slow-update.js";
import { ExperimentSandbox, bootstrapPairedCI } from "./experiment-sandbox.js";
import {
  type HeldOutExecution,
  isHeldOut,
  listHeldOutExecutions,
} from "./skill-execution-selection.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Minimal schema for these integration tests — explicit so the file is
  // self-contained and doesn't drag in the full memory-schema bootstrap.
  db.exec(`CREATE TABLE skill_executions (
    id TEXT PRIMARY KEY,
    skill_crystal_id TEXT NOT NULL,
    session_id TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    success INTEGER,
    reward_score REAL,
    error_type TEXT,
    context_json TEXT DEFAULT '{}'
  )`);
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
  return db;
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

function insertExec(
  db: DatabaseSync,
  args: {
    id: string;
    skillId: string;
    sessionId: string;
    completedAt: number;
    success: boolean;
  },
) {
  db.prepare(
    `INSERT INTO skill_executions (id, skill_crystal_id, session_id, started_at, completed_at, success, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.skillId,
    args.sessionId,
    args.completedAt - 100,
    args.completedAt,
    args.success ? 1 : 0,
    "{}",
  );
}

function insertIntervention(
  db: DatabaseSync,
  args: { id: string; ts: number; skillId: string; sessionKey: string; hormonal: HormonalSnapshot },
) {
  db.prepare(
    `INSERT INTO intervention_records (
       id, ts, session_key, skill, interceptor_id, channel, tool_name,
       intervention_type, action_original_json, intervention_json,
       state_summary_json, record_json
     ) VALUES (?, ?, ?, ?, 'ic1', 'internal', 'send', 'modify', '{}', '{}', ?, '{}')`,
  ).run(
    args.id,
    args.ts,
    args.sessionKey,
    args.skillId,
    JSON.stringify({ hormonal: args.hormonal, channel: "internal" }),
  );
}

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

// ── 1) End-to-end Phase D slow-update flow ─────────────────────────────────

describe("PLAN-21 integration: slow-update end-to-end", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = setupDb();
  });

  it("regressions clustered by hormonal state become high-priority mutation_queue rows", async () => {
    const skillId = "skill-end-to-end";

    // Three executions in low-cortisol context, three in high-cortisol.
    const lowH = hormonal(0.5, 0.2, 0.5);
    const highH = hormonal(0.5, 0.8, 0.5);
    for (let i = 0; i < 3; i++) {
      const execId = `low-exec-${i}`;
      const session = `low-sess-${i}`;
      insertExec(db, {
        id: execId,
        skillId,
        sessionId: session,
        completedAt: 1000 + i,
        success: true,
      });
      insertIntervention(db, {
        id: `low-ic-${i}`,
        ts: 999 + i,
        skillId,
        sessionKey: session,
        hormonal: lowH,
      });
    }
    for (let i = 0; i < 3; i++) {
      const execId = `high-exec-${i}`;
      const session = `high-sess-${i}`;
      insertExec(db, {
        id: execId,
        skillId,
        sessionId: session,
        completedAt: 2000 + i,
        success: true,
      });
      insertIntervention(db, {
        id: `high-ic-${i}`,
        ts: 1999 + i,
        skillId,
        sessionKey: session,
        hormonal: highH,
      });
    }
    snapshotSkillText(db, {
      skillId,
      version: 1,
      text: "OLD: use prettier with default settings",
      promotedAt: 500,
    });

    // Synthetic scorePair: prior passed everywhere, current fails ONLY on the
    // high-cortisol sessions. This is the falsifiable Bitterbot claim: a skill
    // regression can cluster non-randomly in hormonal-state space.
    const selectionSet = listHeldOutExecutions(db, skillId, { fraction: 1.0, limit: 100 });
    expect(selectionSet.length).toBe(6);
    const scorePair: ScorePairFn = async (_prior, _current, set) =>
      set.map((s) => ({
        taskId: s.id,
        aPassed: true, // prior version passed every task
        bPassed: !s.id.startsWith("high-exec-"), // current fails high-cortisol tasks
      }));

    const trajectories = await runLongitudinalRegression({
      db,
      skillId,
      currentVersion: 2,
      currentSkillText: "NEW: use eslint",
      archiveVersions: [{ version: 1, content: "OLD" }],
      selectionSet,
      scorePair,
    });

    const regressions = trajectories.filter((t) => t.classification === "regression");
    expect(regressions.length).toBe(3);
    expect(regressions.every((r) => r.hormonal !== null)).toBe(true);
    expect(regressions.every((r) => r.hormonal!.cortisol > 0.7)).toBe(true);

    const clusters = bindBiologicalContext(
      regressions,
      { ...DEFAULT_SLOW_UPDATE_CONFIG, minClusterSize: 2, kHormonal: 2 },
      seededRng(123),
    );
    expect(clusters.length).toBeGreaterThan(0);
    const highCortisolCluster = clusters.find((c) => c.centroid.cortisol > 0.7);
    expect(highCortisolCluster).toBeTruthy();
    expect(highCortisolCluster!.members.length).toBe(3);

    for (const cluster of clusters) {
      const out = enqueueRegressionPriority(db, { skillId, cluster, now: 5000 });
      expect(out).not.toBeNull();
    }

    const queueRows = db
      .prepare(
        `SELECT skill_crystal_id, strategy, priority, context_annotation
         FROM mutation_queue WHERE strategy = 'regression-priority'`,
      )
      .all() as Array<{
      skill_crystal_id: string;
      strategy: string;
      priority: number;
      context_annotation: string;
    }>;
    expect(queueRows.length).toBe(clusters.length);
    for (const row of queueRows) {
      expect(row.priority).toBeGreaterThan(0.5);
      const annotation = JSON.parse(row.context_annotation) as {
        source: string;
        clusterSize: number;
        sampleTaskIds: string[];
      };
      expect(annotation.source).toBe("plan21-slow-update");
      expect(annotation.clusterSize).toBeGreaterThan(0);
      expect(annotation.sampleTaskIds.length).toBeGreaterThan(0);
    }
  });
});

// ── 2) Bootstrap CI bound properties ────────────────────────────────────────

describe("PLAN-21 property: bootstrapPairedCI bounds", () => {
  it("ci95Low > 0 when every trial is a strict improvement", () => {
    const paired = Array.from({ length: 20 }, () => ({
      executionId: "x",
      originalPassed: false,
      mutatedPassed: true,
    }));
    const ci = bootstrapPairedCI(paired, 500, seededRng(1));
    expect(ci.ci95Low).toBeGreaterThan(0);
    expect(ci.delta).toBe(1);
  });

  it("ci95High < 0 when every trial is a strict regression", () => {
    const paired = Array.from({ length: 20 }, () => ({
      executionId: "x",
      originalPassed: true,
      mutatedPassed: false,
    }));
    const ci = bootstrapPairedCI(paired, 500, seededRng(2));
    expect(ci.ci95High).toBeLessThan(0);
    expect(ci.delta).toBe(-1);
  });

  it("CI brackets zero when wins and losses balance", () => {
    const paired = [
      ...Array.from({ length: 5 }, () => ({
        executionId: "win",
        originalPassed: false,
        mutatedPassed: true,
      })),
      ...Array.from({ length: 5 }, () => ({
        executionId: "loss",
        originalPassed: true,
        mutatedPassed: false,
      })),
    ];
    const ci = bootstrapPairedCI(paired, 500, seededRng(3));
    expect(ci.delta).toBe(0);
    expect(ci.ci95Low).toBeLessThanOrEqual(0);
    expect(ci.ci95High).toBeGreaterThanOrEqual(0);
  });

  it("CI width contracts as sample size grows (same effect size)", () => {
    // Pattern of 80% improvements, repeated at two scales.
    function makePaired(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        executionId: `e${i}`,
        originalPassed: i % 5 === 0,
        mutatedPassed: true,
      }));
    }
    const small = bootstrapPairedCI(makePaired(8), 500, seededRng(11));
    const large = bootstrapPairedCI(makePaired(80), 500, seededRng(11));
    const smallWidth = small.ci95High - small.ci95Low;
    const largeWidth = large.ci95High - large.ci95Low;
    // The large-N CI should be at least 30% tighter than the small-N CI.
    expect(largeWidth).toBeLessThan(smallWidth * 0.7);
  });
});

// ── 3) Skill text history bytes-exact preservation ─────────────────────────

describe("PLAN-21 property: skill_text_history preserves bytes exactly", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = setupDb();
  });

  it("round-trips Unicode text without truncation or normalisation", () => {
    const text =
      "skill: ⚛️ format ⇒ prettier (𝒩 = 100, σ ≈ 0.5) — keep défaults; 中文; emoji: 🧬🧠";
    expect(
      snapshotSkillText(db, {
        skillId: "skill-unicode",
        version: 7,
        text,
        promotedAt: 1234567890,
      }),
    ).toBe(true);
    const history = readSkillTextHistory(db, "skill-unicode", 1);
    expect(history.length).toBe(1);
    expect(history[0]?.content).toBe(text);
  });

  it("handles a multi-kilobyte payload", () => {
    const body = "x".repeat(200_000);
    snapshotSkillText(db, {
      skillId: "skill-big",
      version: 1,
      text: body,
      promotedAt: 1,
    });
    const out = readSkillTextHistory(db, "skill-big", 1);
    expect(out[0]?.content.length).toBe(200_000);
  });
});

// ── 4) scoreVersionPair determinism ─────────────────────────────────────────

describe("PLAN-21: ExperimentSandbox.scoreVersionPair determinism", () => {
  it("produces identical paired outcomes for identical inputs and stub", async () => {
    const db = setupDb();
    const fixedResp = JSON.stringify({
      trials: [
        { index: 1, originalPassed: true, mutatedPassed: false },
        { index: 2, originalPassed: false, mutatedPassed: true },
        { index: 3, originalPassed: true, mutatedPassed: true },
      ],
    });
    const stub = async () => fixedResp;
    const sandbox = new ExperimentSandbox(db, stub);

    const selectionSet: HeldOutExecution[] = [
      {
        id: "t1",
        skillId: "s",
        sessionId: null,
        completedAt: 1,
        success: true,
        rewardScore: null,
        errorType: null,
        contextJson: "{}",
      },
      {
        id: "t2",
        skillId: "s",
        sessionId: null,
        completedAt: 2,
        success: true,
        rewardScore: null,
        errorType: null,
        contextJson: "{}",
      },
      {
        id: "t3",
        skillId: "s",
        sessionId: null,
        completedAt: 3,
        success: true,
        rewardScore: null,
        errorType: null,
        contextJson: "{}",
      },
    ];

    const r1 = await sandbox.scoreVersionPair("prior", "current", selectionSet);
    const r2 = await sandbox.scoreVersionPair("prior", "current", selectionSet);
    expect(r1).toEqual(r2);
    expect(r1.length).toBe(3);
    expect(r1[0]).toEqual({ taskId: "t1", aPassed: true, bPassed: false });
  });

  it("returns empty array when selection set is empty (no LLM call)", async () => {
    let called = false;
    const sandbox = new ExperimentSandbox(setupDb(), async () => {
      called = true;
      return "{}";
    });
    const out = await sandbox.scoreVersionPair("a", "b", []);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

// ── 5) Selection set stability under churn ──────────────────────────────────

describe("PLAN-21 property: selection-set stability under DB churn", () => {
  it("a row tagged held-out stays held-out after new inserts", () => {
    const db = setupDb();
    const skillId = "skill-churn";
    // Seed 30 executions, identify which IDs land in the held-out bucket.
    for (let i = 0; i < 30; i++) {
      insertExec(db, {
        id: `churn-A-${i}`,
        skillId,
        sessionId: `sess-A-${i}`,
        completedAt: 1000 + i,
        success: true,
      });
    }
    const firstHeldOutIds = new Set(
      listHeldOutExecutions(db, skillId, { limit: 100 }).map((e) => e.id),
    );
    expect(firstHeldOutIds.size).toBeGreaterThan(0);

    // Insert 60 more, then re-query.
    for (let i = 0; i < 60; i++) {
      insertExec(db, {
        id: `churn-B-${i}`,
        skillId,
        sessionId: `sess-B-${i}`,
        completedAt: 5000 + i,
        success: true,
      });
    }
    const allHeldOutIds = new Set(
      listHeldOutExecutions(db, skillId, { limit: 200 }).map((e) => e.id),
    );
    // Every previously-held-out id remains in the new query (within recency).
    for (const id of firstHeldOutIds) {
      expect(isHeldOut(id)).toBe(true);
      expect(allHeldOutIds.has(id)).toBe(true);
    }
  });
});

// ── 6) classifyOutcome × every input pair ──────────────────────────────────

describe("PLAN-21 invariant: classifyOutcome covers the 4-way taxonomy", () => {
  it("partitions the (priorPassed, currentPassed) plane into exactly four cells", () => {
    expect(classifyOutcome(true, true)).toBe("stable-success");
    expect(classifyOutcome(true, false)).toBe("regression");
    expect(classifyOutcome(false, true)).toBe("improvement");
    expect(classifyOutcome(false, false)).toBe("persistent-failure");
  });
});
