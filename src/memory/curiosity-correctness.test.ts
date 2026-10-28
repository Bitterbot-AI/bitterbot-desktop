/**
 * Regression tests for the GCCRF / curiosity-target defects found in the
 * 2026-10 audit (one `it` per defect, in audit order where possible):
 *
 *  1. an unrelated simulation insight closed every open contradiction target
 *  2. paraphrases (identical embeddings, different hash) scored as contradictions
 *  3. per-query min/max stretch erased absolute distance from the density term
 *  4. KNN returned the assessed chunk as its own nearest neighbour
 *  5. no-progress normalized to 0.5 instead of 0
 *  6. the progress history read the OLDEST 50 samples
 *  7. rebuild clamped progress non-negative before the stale (< -0.3) detector ran
 *  8. FSHO alpha coupling was computed but never consumed
 *  9. maturity came from chunk count / calendar age, not completed dream cycles
 * 10. GCCRF target generation re-inserted the same (type, region) target every run
 * 11. `curiosity_stagnant` fired on every single sub-0.2 score
 * 12. the novelty term dropped the 4/(1-α²) prefactor, which reverses the
 *     ordering for α < -1 (young agents rewarded the most familiar material)
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CuriosityEngine, deriveStableRegionId } from "./curiosity-engine.js";
import type { DreamInsight } from "./dream-types.js";
import { GCCRFRewardFunction, informationGeometricNovelty } from "./gccrf-reward.js";
import { HormonalStateManager } from "./hormonal.js";

const databases: DatabaseSync[] = [];

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE chunks (
    id TEXT PRIMARY KEY, hash TEXT, embedding TEXT, model TEXT DEFAULT 'test',
    lifecycle_state TEXT DEFAULT 'active', updated_at INTEGER, created_at INTEGER,
    semantic_type TEXT DEFAULT 'fact', importance_score REAL DEFAULT 0.5,
    access_count INTEGER DEFAULT 0, text TEXT DEFAULT '')`);
  return db;
}

function insert(
  db: DatabaseSync,
  id: string,
  embedding: number[],
  text = "memory systems knowledge",
) {
  db.prepare(
    "INSERT INTO chunks(id, hash, embedding, updated_at, created_at, text) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, id, JSON.stringify(embedding), Date.now(), Date.now(), text);
}

function insight(overrides: Partial<DreamInsight>): DreamInsight {
  return {
    id: "dream",
    content: "unrelated hypothesis",
    embedding: [0, 1],
    confidence: 0.99,
    mode: "simulation",
    sourceChunkIds: [],
    sourceClusterIds: [],
    dreamCycleId: "cycle",
    importanceScore: 0.5,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describe("GCCRF reward defects", () => {
  it("3. distinguishes nearby and distant neighbourhoods with identical relative spacing", () => {
    const density = (offset: number) => {
      const db = fixture();
      for (let i = 0; i < 50; i++) {
        const d = offset + i * 0.002;
        insert(db, `n${i}`, [1 - d, Math.sqrt(1 - (1 - d) ** 2)]);
      }
      return new GCCRFRewardFunction(db).compute([1, 0], new Map(), []).density;
    };
    // Same internal spacing; the old per-query stretch gave both the same density.
    expect(density(0.01)).toBeGreaterThan(0.9);
    expect(density(0.7)).toBeLessThan(0.1);
  });

  it("3b. falls back to the default bandwidth on an invalid config value", () => {
    const db = fixture();
    expect(
      new GCCRFRewardFunction(db, { densityBandwidth: NaN }).getConfig().densityBandwidth,
    ).toBe(0.3);
    expect(new GCCRFRewardFunction(db, { densityBandwidth: -1 }).getConfig().densityBandwidth).toBe(
      0.3,
    );
  });

  it("5 + 9. preserves zero progress and does not infer maturity from 500 imported memories", () => {
    const db = fixture();
    for (let i = 0; i < 500; i++) {
      insert(db, String(i), []);
    }
    const reward = new GCCRFRewardFunction(db);
    for (let i = 0; i < 100; i++) {
      expect(reward.compute([1, 0], new Map([["r", [1, 0]]]), []).components.deltaEta).toBe(0);
    }
    expect(reward.getMaturity()).toBe(0);
    expect(reward.getCurrentAlpha()).toBe(-3);
  });

  it("9b. maturity follows completed dream cycles only", () => {
    const db = fixture();
    db.exec("CREATE TABLE dream_cycles (id TEXT, completed_at INTEGER)");
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO dream_cycles VALUES (?, ?)").run(String(i), i < 40 ? 1 : null);
    }
    const reward = new GCCRFRewardFunction(db, { expectedMatureCycles: 100 });
    expect(reward.getMaturity()).toBeCloseTo(0.4);
    expect(reward.getCurrentAlpha()).toBeCloseTo(-3 + 3 * 0.4);
  });

  it("8. consumes FSHO coupling only when enabled, and the EMA survives a restart", () => {
    const db = fixture();
    const off = new GCCRFRewardFunction(db);
    off.updateFshoR(1);
    expect(off.compute([1, 0], new Map(), []).alpha).toBe(off.getCurrentAlpha());

    const on = new GCCRFRewardFunction(db, { fshoCoupling: true });
    on.updateFshoR(1);
    on.saveState();
    const next = new GCCRFRewardFunction(db, { fshoCoupling: true });
    expect(next.compute([1, 0], new Map(), []).alpha).toBeGreaterThan(next.getCurrentAlpha());
    expect(next.getFshoRAvg()).toBeCloseTo(on.getFshoRAvg());
  });

  it("3c. loads v2 state but resets normalizer statistics stamped with another version", () => {
    const db = fixture();
    const reward = new GCCRFRewardFunction(db);
    reward.compute([1, 0], new Map([["r", [1, 0]]]), []);
    reward.saveState();
    const reloaded = new GCCRFRewardFunction(db).getState();
    expect(reloaded.totalChunksProcessed).toBe(1);
    expect(Object.keys(reloaded.regionEta)).toEqual(["r"]);
    expect(reloaded.normalizers.eta!.count).toBe(1);

    db.exec("UPDATE gccrf_state SET value = 'gccrf-v1' WHERE key = 'scoring_version'");
    const reset = new GCCRFRewardFunction(db).getState();
    expect(reset.regionEta).toEqual({});
    expect(reset.normalizers.eta!.count).toBe(0);
    // Version-independent counters are kept.
    expect(reset.totalChunksProcessed).toBe(1);

    // Legacy rows with no version key at all are treated the same way.
    db.exec("DELETE FROM gccrf_state WHERE key = 'scoring_version'");
    expect(new GCCRFRewardFunction(db).getState().regionEta).toEqual({});
  });

  it("4. excludes the assessed chunk and archived chunks from its neighbourhood (fallback path)", () => {
    const db = fixture();
    for (const id of ["self", "valid", "archived"]) {
      insert(db, id, [1, 0]);
    }
    db.exec("UPDATE chunks SET lifecycle_state = 'archived' WHERE id = 'archived'");
    const reward = new GCCRFRewardFunction(db) as unknown as {
      knnSearch(e: number[], k: number, c: { chunkId: string }): Array<{ id: string }>;
    };
    expect(reward.knnSearch([1, 0], 10, { chunkId: "self" }).map((n) => n.id)).toEqual(["valid"]);
  });

  it("12. novelty is strictly decreasing in density for every alpha, with the eq. 23 prefactor", () => {
    const ps = [0.01, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.999];
    for (const alpha of [-3, -2, -1, -0.5, 0]) {
      const values = ps.map((p) => informationGeometricNovelty(p, alpha));
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!).toBeLessThan(values[i - 1]!);
      }
      expect(values.every(Number.isFinite)).toBe(true);
    }
    // alpha = 0 reduces to 4(1/sqrt(p) - 1); alpha = -3 to (1 - p) / 2 (bounded below 0.5).
    for (const p of ps) {
      expect(informationGeometricNovelty(p, 0)).toBeCloseTo(4 * (1 / Math.sqrt(p) - 1), 10);
      expect(informationGeometricNovelty(p, -3)).toBeCloseTo((1 - p) / 2, 10);
      expect(informationGeometricNovelty(p, -1)).toBeCloseTo(-Math.log(p), 10);
    }
    // The window around -1 is continuous with the log limit, not the unstable prefactor.
    expect(informationGeometricNovelty(0.2, -1 + 5e-4)).toBeCloseTo(-Math.log(0.2), 2);
    expect(informationGeometricNovelty(0.2, -1.01)).toBeCloseTo(-Math.log(0.2), 1);
  });
});

describe("curiosity-engine defects", () => {
  it("2. scores a paraphrase (identical embedding, different hash) as 0, keeps the candidate band", () => {
    const db = fixture();
    const engine = new CuriosityEngine(db);
    insert(db, "a", [1, 0], "The service is available.");
    insert(db, "b", [1, 0], "The service is available!");
    expect(engine.assessChunk("b", [1, 0], "b")!.contradictionScore).toBe(0);

    // cosine ~0.95: inside the candidate band, still flagged (candidate, not adjudication).
    const near = [Math.cos(0.3), Math.sin(0.3)];
    insert(db, "c", near, "The service is down.");
    expect(engine.assessChunk("c", near, "c")!.contradictionScore).toBeGreaterThan(0.7);
  });

  it("1. an unrelated simulation leaves contradiction targets open; a scoped one closes its target", () => {
    const db = fixture();
    const engine = new CuriosityEngine(db);
    const targetInsert = db.prepare(
      "INSERT INTO curiosity_targets VALUES (?, 'contradiction', ?, 0.8, ?, ?, ?, NULL, ?)",
    );
    targetInsert.run(
      "a",
      "a",
      null,
      JSON.stringify({ chunkIds: ["x1", "x2"] }),
      Date.now(),
      Date.now() + 100000,
    );
    targetInsert.run(
      "b",
      "b",
      null,
      JSON.stringify({ chunkIds: ["y1"] }),
      Date.now(),
      Date.now() + 100000,
    );

    const unrelated = engine.assessDreamInsight(insight({ content: "unrelated hypothesis" }));
    expect(unrelated.contradictions).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM curiosity_targets WHERE resolved_at IS NOT NULL").get(),
    ).toEqual({ n: 0 });

    const scoped = engine.assessDreamInsight(insight({ id: "d2", sourceChunkIds: ["x2"] }));
    expect(scoped.contradictions).toBe(1);
    expect(
      db.prepare("SELECT id FROM curiosity_targets WHERE resolved_at IS NOT NULL").all(),
    ).toEqual([{ id: "a" }]);
  });

  it("1b. a simulation in the target's region that names it also closes the target", () => {
    const db = fixture();
    const engine = new CuriosityEngine(db);
    db.prepare(
      "INSERT INTO curiosity_regions VALUES ('r','docker deployment','[1,0]',10,0,0.5,0.1,0,?,?)",
    ).run(Date.now(), Date.now());
    db.prepare(
      "INSERT INTO curiosity_targets VALUES ('t', 'contradiction', 'conflict', 0.8, 'r', '{}', ?, NULL, ?)",
    ).run(Date.now(), Date.now() + 100000);
    // Right region, wrong subject: stays open.
    engine.assessDreamInsight(insight({ embedding: [1, 0], content: "a thought about cooking" }));
    expect(db.prepare("SELECT resolved_at FROM curiosity_targets WHERE id = 't'").get()).toEqual({
      resolved_at: null,
    });
    engine.assessDreamInsight(
      insight({
        id: "d2",
        embedding: [1, 0],
        content: "Docker deployment ordering resolves the conflict",
      }),
    );
    expect(
      (
        db.prepare("SELECT resolved_at FROM curiosity_targets WHERE id = 't'").get() as {
          resolved_at: number | null;
        }
      ).resolved_at,
    ).not.toBeNull();
  });

  it("6. incorporates the newest progress window", () => {
    const db = fixture();
    const engine = new CuriosityEngine(db);
    db.prepare(
      "INSERT INTO curiosity_regions VALUES ('r','region','[1,0]',10,0,0.5,0.1,0,?,?)",
    ).run(Date.now(), Date.now());
    // 50 old samples at high error, then 10 recent ones at low error: the
    // newest window must see the drop.
    for (let i = 0; i < 60; i++) {
      db.prepare("INSERT INTO curiosity_progress VALUES (?, 'r', ?, ?)").run(
        String(i),
        i < 50 ? 0.8 : 0.1,
        Date.now() - (60 - i) * 60000,
      );
    }
    (
      engine as unknown as { computeRegionLearningProgress(): void }
    ).computeRegionLearningProgress();
    expect(
      Number(
        (
          db.prepare("SELECT learning_progress FROM curiosity_regions WHERE id='r'").get() as {
            learning_progress: number;
          }
        ).learning_progress,
      ),
    ).toBeGreaterThan(0.5);
  });

  it("7. keeps signed drift through rebuild and detects a stale region in the same cycle", async () => {
    const db = fixture();
    const engine = new CuriosityEngine(db);
    for (let i = 0; i < 6; i++) {
      insert(db, String(i), [1, 0]);
    }
    const id = deriveStableRegionId("memory-systems-knowledge");
    db.prepare(
      "INSERT INTO curiosity_regions VALUES (?, 'memory-systems-knowledge', '[1,0]',6,0,0.5,0,0,?,?)",
    ).run(id, Date.now(), Date.now());
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO curiosity_progress VALUES (?, ?, ?, ?)").run(
        String(i),
        id,
        i / 50,
        Date.now() - (50 - i) * 60000,
      );
    }
    await engine.run();
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM curiosity_targets WHERE type='stale_region'")
          .get() as { n: number }
      ).n,
    ).toBeGreaterThan(0);
  });

  it("7b. the rebuild writes a signed single-step progress value", async () => {
    const db = fixture();
    const engine = new CuriosityEngine(db);
    for (let i = 0; i < 6; i++) {
      insert(db, String(i), [1, 0]);
    }
    const id = deriveStableRegionId("memory-systems-knowledge");
    // Prior error 0 -> new error 0 would be 0; seed a NEGATIVE prior so the
    // rebuild's (prior - new) is negative and must survive as such.
    db.prepare(
      "INSERT INTO curiosity_regions VALUES (?, 'memory-systems-knowledge', '[1,0]',6,0,0.5,-0.5,0,?,?)",
    ).run(id, Date.now(), Date.now());
    await (engine as unknown as { rebuildRegions(): Promise<number> }).rebuildRegions();
    const row = db
      .prepare("SELECT learning_progress FROM curiosity_regions WHERE id = ?")
      .get(id) as { learning_progress: number } | undefined;
    expect(row?.learning_progress).toBeLessThan(0);
  });

  it("10. deduplicates repeated GCCRF region targets", () => {
    const db = fixture();
    const engine = new CuriosityEngine(db);
    db.prepare(
      "INSERT INTO curiosity_regions VALUES ('r','region','[1,0]',10,0,0.5,0.8,0,?,?)",
    ).run(Date.now(), Date.now());
    db.prepare("INSERT INTO gccrf_state VALUES ('region_eta', ?, ?)").run(
      JSON.stringify({ r: { emaLong: 0.8, emaShort: 0.8, sampleCount: 12 } }),
      Date.now(),
    );
    expect(engine.generateGCCRFTargets()).toBe(2);
    expect(engine.generateGCCRFTargets()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM curiosity_targets").get()).toEqual({ n: 2 });
  });
});

describe("hormonal stagnation window", () => {
  const components = { eta: 0.1, deltaEta: 0, iAlpha: 0.1, empowerment: 0.1, strategic: 0.1 };

  it("11. emits curiosity_stagnant only after a sustained run of low rewards", () => {
    const h = new HormonalStateManager();
    const events: string[] = [];
    for (let i = 0; i < 4; i++) {
      events.push(...h.stimulateFromGCCRF(0.1, components));
    }
    expect(events).not.toContain("curiosity_stagnant");
    events.push(...h.stimulateFromGCCRF(0.1, components));
    expect(events.filter((e) => e === "curiosity_stagnant")).toHaveLength(1);
  });

  it("11b. a single ordinary reward resets the run", () => {
    const h = new HormonalStateManager();
    const events: string[] = [];
    for (let i = 0; i < 4; i++) {
      events.push(...h.stimulateFromGCCRF(0.1, components));
    }
    events.push(...h.stimulateFromGCCRF(0.5, components));
    for (let i = 0; i < 4; i++) {
      events.push(...h.stimulateFromGCCRF(0.1, components));
    }
    expect(events).not.toContain("curiosity_stagnant");
  });
});
