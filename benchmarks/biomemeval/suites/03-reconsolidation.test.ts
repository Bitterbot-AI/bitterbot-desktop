/**
 * BioMemEval Suite 3: Reconsolidation Accuracy (20% weight)
 *
 * Tests whether the system supports labile states with time-windowed
 * update capability — the first implementation of memory reconsolidation
 * in any agent memory system.
 *
 * Reference: Nader, Schafe & LeDoux (2000)
 */

import type { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { ReconsolidationEngine } from "../../../src/memory/reconsolidation.js";
import { createBenchmarkDb } from "../db-setup.js";
import { insertChunk } from "../helpers.js";
import { ScenarioScorer, SuiteScorer } from "../scoring.js";

const suite = new SuiteScorer("Reconsolidation Accuracy", "03-reconsolidation", 20, 20);

describe("BioMemEval > Reconsolidation Accuracy", () => {
  let db: DatabaseSync;
  let engine: ReconsolidationEngine;

  beforeEach(() => {
    db = createBenchmarkDb();
    engine = new ReconsolidationEngine(db);
  });

  it("Scenario 1: Labile window activation (4 pts)", () => {
    const s = new ScenarioScorer("Labile Window Activation", 4);

    const id = insertChunk(db, { importance_score: 0.5, text: "Alice is the project lead" });

    s.score("markLabile returns true for eligible chunk", engine.markLabile(id), 1);
    s.score("isLabile returns true immediately after marking", engine.isLabile(id), 1);

    // Verify the chunk has labile_until set in the DB
    const row = db.prepare("SELECT labile_until FROM chunks WHERE id = ?").get(id) as any;
    s.score("labile_until is set in database", row?.labile_until > Date.now(), 1);

    // Verify labile chunks list includes this chunk
    const labileChunks = engine.getLabileChunks();
    s.score(
      "getLabileChunks includes the marked chunk",
      labileChunks.some((c) => c.chunkId === id),
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 2: Strengthen within window (4 pts)", () => {
    const s = new ScenarioScorer("Strengthen Within Window", 4);

    const id = insertChunk(db, { importance_score: 0.5, text: "The API endpoint is /v2/users" });
    engine.markLabile(id);

    const beforeRow = db
      .prepare("SELECT importance_score, reconsolidation_count FROM chunks WHERE id = ?")
      .get(id) as any;
    const beforeImportance = beforeRow.importance_score;

    const strengthened = engine.strengthen(id);

    const afterRow = db
      .prepare(
        "SELECT importance_score, reconsolidation_count, labile_until FROM chunks WHERE id = ?",
      )
      .get(id) as any;

    s.score("strengthen returns true", strengthened, 1.5);
    s.score(
      "importance increased by confirmation boost",
      afterRow.importance_score > beforeImportance,
      1,
    );
    s.score("chunk is no longer labile after strengthening", !engine.isLabile(id), 0.75);
    s.score(
      "reconsolidation_count incremented",
      afterRow.reconsolidation_count > (beforeRow.reconsolidation_count ?? 0),
      0.75,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 3: Contradiction flagging (4 pts)", () => {
    const s = new ScenarioScorer("Contradiction Flagging", 4);

    const id = insertChunk(db, { importance_score: 0.6, text: "Alice is the project lead" });
    engine.markLabile(id);

    const flagged = engine.flagContradiction(id, "Bob replaced Alice as lead in March");

    const row = db
      .prepare("SELECT labile_until, open_loop, open_loop_context FROM chunks WHERE id = ?")
      .get(id) as any;

    s.score("flagContradiction returns true", flagged, 1.5);
    s.score("chunk is no longer labile after flagging", !engine.isLabile(id), 1);
    s.score("open_loop is set to 1", row?.open_loop === 1, 0.75);
    s.score(
      "open_loop_context contains contradiction info",
      typeof row?.open_loop_context === "string" && row.open_loop_context.length > 0,
      0.75,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 4: Window expiration and restabilization (4 pts)", () => {
    const s = new ScenarioScorer("Window Expiration + Restabilization", 4);

    // Create 3 chunks with very short labile window (already expired)
    const ids: string[] = [];
    const shortWindowEngine = new ReconsolidationEngine(db, { labileWindowMs: 1 });

    for (let i = 0; i < 3; i++) {
      const id = insertChunk(db, { importance_score: 0.5 + i * 0.1 });
      shortWindowEngine.markLabile(id);
      ids.push(id);
    }

    // Wait for the 1ms window to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }

    const restabilized = shortWindowEngine.restabilizeExpired();

    s.score("restabilizeExpired returns 3", restabilized === 3, 1.5);

    // All should have received the recall boost
    let allBoosted = true;
    for (const id of ids) {
      const row = db
        .prepare("SELECT importance_score, labile_until FROM chunks WHERE id = ?")
        .get(id) as any;
      if (engine.isLabile(id)) {
        allBoosted = false;
      }
    }

    s.score("none are labile after restabilization", allBoosted, 1.25);
    s.score(
      "all chunks received recall boost",
      ids.every((id) => {
        const row = db.prepare("SELECT importance_score FROM chunks WHERE id = ?").get(id) as any;
        return row.importance_score >= 0.5; // at least the original + boost
      }),
      1.25,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 5: Non-labile rejection (4 pts)", () => {
    const s = new ScenarioScorer("Non-Labile Rejection", 4);

    const id = insertChunk(db, { importance_score: 0.5, text: "A normal memory" });
    // Do NOT mark labile

    s.score("strengthen returns false for non-labile", !engine.strengthen(id), 1);
    s.score(
      "flagContradiction returns false for non-labile",
      !engine.flagContradiction(id, "test"),
      1,
    );

    // Low importance should also be rejected
    const lowId = insertChunk(db, { importance_score: 0.05 });
    s.score("markLabile returns false for low importance", !engine.markLabile(lowId), 1);

    // Disabled engine should reject everything
    const disabledEngine = new ReconsolidationEngine(db, { enabled: false });
    const normalId = insertChunk(db, { importance_score: 0.5 });
    s.score("markLabile returns false when disabled", !disabledEngine.markLabile(normalId), 1);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });
});
