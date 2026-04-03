/**
 * BioMemEval Suite 1: Zeigarnik Proactivity (20% weight)
 *
 * Tests whether the system detects unfinished tasks and surfaces them
 * proactively — implementing the Zeigarnik effect in agent memory.
 *
 * Reference: Zeigarnik, B. (1927). Das Behalten erledigter und unerledigter Handlungen.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createBenchmarkDb } from "../db-setup.js";
import { insertChunk } from "../helpers.js";
import {
  detectOpenLoop,
  detectResolution,
  markOpenLoop,
  closeOpenLoop,
  getActiveOpenLoops,
  scanForOpenLoops,
} from "../../../src/memory/zeigarnik-effect.js";
import { ScenarioScorer, SuiteScorer } from "../scoring.js";

const suite = new SuiteScorer("Zeigarnik Proactivity", "01-zeigarnik", 20, 20);

describe("BioMemEval > Zeigarnik Proactivity", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createBenchmarkDb();
  });

  it("Scenario 1: Open loop detection accuracy (4 pts)", () => {
    const s = new ScenarioScorer("Open Loop Detection", 4);

    const openTexts = [
      "Need to fix the auth bug later when I have time",
      "Working on the migration, still WIP, not done yet",
      "I'm not sure how to solve the caching issue at all",
      "The build error is still unresolved after two attempts",
      "Going to deploy to staging once the tests pass tomorrow",
    ];
    const resolvedTexts = [
      "Fixed the auth bug, all tests passing now",
      "Migration is done and deployed to production",
      "Completed the rate limiter implementation successfully",
      "Solved the caching issue by switching to Redis",
      "Finished deploying to staging, everything works now",
    ];

    let correctOpen = 0;
    let correctResolved = 0;

    for (const text of openTexts) {
      if (detectOpenLoop(text) !== null) correctOpen++;
    }
    for (const text of resolvedTexts) {
      if (detectOpenLoop(text) === null || detectResolution(text)) correctResolved++;
    }

    s.score(
      `detected ${correctOpen}/5 open loops correctly`,
      correctOpen >= 4,
      2,
    );
    s.score(
      `classified ${correctResolved}/5 resolved texts correctly`,
      correctResolved >= 4,
      2,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBeGreaterThanOrEqual(3);
  });

  it("Scenario 2: Proactive surfacing order (4 pts)", () => {
    const s = new ScenarioScorer("Proactive Surfacing Order", 4);

    // Insert 8 chunks: 3 open loops with varying importance, 5 normal
    const loop1 = insertChunk(db, { text: "Need to fix auth bug", importance_score: 0.9 });
    markOpenLoop(db, loop1, "auth bug unfixed");

    const loop2 = insertChunk(db, { text: "TODO: rate limiter", importance_score: 0.7 });
    markOpenLoop(db, loop2, "rate limiter pending");

    const loop3 = insertChunk(db, { text: "Working on caching WIP", importance_score: 0.5 });
    markOpenLoop(db, loop3, "caching in progress");

    for (let i = 0; i < 5; i++) {
      insertChunk(db, { text: `Normal memory ${i}`, importance_score: 0.8 });
    }

    const loops = getActiveOpenLoops(db, 3);

    s.score("returns exactly 3 results", loops.length === 3, 1);
    s.score("all results are open loops", loops.every((l) => l.context !== undefined && l.context !== null), 1);
    s.score(
      "ordered by importance (highest first)",
      loops.length >= 2 && loops[0]!.importance >= loops[1]!.importance,
      1,
    );
    s.score(
      "highest importance loop is first",
      loops[0]?.id === loop1,
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBeGreaterThanOrEqual(3);
  });

  it("Scenario 3: Resolution detection (4 pts)", () => {
    const s = new ScenarioScorer("Resolution Detection", 4);

    const loop1 = insertChunk(db, { text: "Need to fix auth", importance_score: 0.7 });
    markOpenLoop(db, loop1, "auth issue");

    const loop2 = insertChunk(db, { text: "TODO: deploy staging", importance_score: 0.6 });
    markOpenLoop(db, loop2, "staging deploy");

    const loop3 = insertChunk(db, { text: "WIP migration", importance_score: 0.5 });
    markOpenLoop(db, loop3, "migration");

    // Resolve loop1
    closeOpenLoop(db, loop1);

    const remaining = getActiveOpenLoops(db, 5);

    s.score("resolved loop no longer in active list", !remaining.some((l) => l.id === loop1), 2);
    s.score("remaining open loops still surface", remaining.length === 2, 1);
    s.score(
      "remaining loops are the correct ones",
      remaining.some((l) => l.id === loop2) && remaining.some((l) => l.id === loop3),
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 4: Decay resistance (4 pts)", () => {
    const s = new ScenarioScorer("Decay Resistance", 4);

    const loopId = insertChunk(db, { text: "TODO: implement cache", importance_score: 0.5 });
    markOpenLoop(db, loopId, "cache pending");

    const normalId = insertChunk(db, { text: "Cache was implemented", importance_score: 0.5 });

    // Verify the open_loop flag is set
    const loopRow = db.prepare("SELECT open_loop FROM chunks WHERE id = ?").get(loopId) as any;
    const normalRow = db.prepare("SELECT open_loop FROM chunks WHERE id = ?").get(normalId) as any;

    s.score("open loop chunk has open_loop = 1", loopRow?.open_loop === 1, 2);
    s.score("normal chunk has open_loop = 0", normalRow?.open_loop === 0, 2);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 5: Multi-session compound scenario (4 pts)", () => {
    const s = new ScenarioScorer("Multi-Session Compound", 4);

    // Session 1: Create 3 open loops
    const s1loop1 = insertChunk(db, { text: "Need to fix login flow", importance_score: 0.8 });
    markOpenLoop(db, s1loop1, "login flow broken");
    const s1loop2 = insertChunk(db, { text: "TODO: add rate limiting", importance_score: 0.7 });
    markOpenLoop(db, s1loop2, "rate limiting needed");
    const s1loop3 = insertChunk(db, { text: "Working on DB migration WIP", importance_score: 0.6 });
    markOpenLoop(db, s1loop3, "migration in progress");

    // Session 2: Resolve 1, create 2 new
    closeOpenLoop(db, s1loop1);
    const s2loop1 = insertChunk(db, { text: "Need to update API docs", importance_score: 0.75 });
    markOpenLoop(db, s2loop1, "docs outdated");
    const s2loop2 = insertChunk(db, { text: "TODO: fix memory leak in worker", importance_score: 0.85 });
    markOpenLoop(db, s2loop2, "worker memory leak");

    const allLoops = getActiveOpenLoops(db, 5);

    s.score("returns exactly 4 unresolved loops", allLoops.length === 4, 2);
    s.score("resolved loop is not in results", !allLoops.some((l) => l.id === s1loop1), 1);
    s.score(
      "all returned loops have context",
      allLoops.every((l) => l.context !== undefined && l.context !== null && l.context.length > 0),
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });
});
