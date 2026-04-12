/**
 * BioMemEval Suite 5: Identity Continuity (15% weight)
 *
 * Tests whether the system maintains a coherent self-model, actively
 * identifies knowledge gaps, and provides emotional pre-filtering.
 *
 * References:
 * - Friston, K. (2010). The free-energy principle.
 * - Damasio, A.R. (1994). Descartes' Error.
 */

import type { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { EpistemicDirectiveEngine } from "../../../src/memory/epistemic-directives.js";
import { assessSomaticMarkers } from "../../../src/memory/somatic-markers.js";
import { createBenchmarkDb } from "../db-setup.js";
import { insertChunk } from "../helpers.js";
import { ScenarioScorer, SuiteScorer } from "../scoring.js";

const suite = new SuiteScorer("Identity Continuity", "05-identity", 15, 15);

describe("BioMemEval > Identity Continuity", () => {
  let db: DatabaseSync;
  let directives: EpistemicDirectiveEngine;

  beforeEach(() => {
    db = createBenchmarkDb();
    directives = new EpistemicDirectiveEngine(db);
  });

  it("Scenario 1: Directive creation (3 pts)", () => {
    const s = new ScenarioScorer("Directive Creation", 3);

    const d1 = directives.createDirective({
      type: "contradiction",
      question: "Is the DB Postgres or MySQL?",
      priority: 0.9,
    });
    const d2 = directives.createDirective({
      type: "knowledge_gap",
      question: "What deployment pipeline does the team use?",
      priority: 0.7,
    });
    const d3 = directives.createDirective({
      type: "low_confidence",
      question: "Is the API versioned at v2 or v3?",
      priority: 0.5,
    });
    const d4 = directives.createDirective({
      type: "stale_fact",
      question: "Is Alice still the project lead?",
      priority: 0.3,
    });

    s.score(
      "all 4 directives created",
      [d1, d2, d3, d4].every((d) => d !== null),
      1,
    );

    const session = directives.getDirectivesForSession();
    s.score(
      "getDirectivesForSession returns top directives",
      session.length > 0 && session.length <= 2,
      1,
    );
    s.score(
      "highest priority directive is first",
      session[0]?.priority === 0.9 || (session[0]?.priority ?? 0) >= (session[1]?.priority ?? 0),
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(3);
  });

  it("Scenario 2: Directive resolution (3 pts)", () => {
    const s = new ScenarioScorer("Directive Resolution", 3);

    const d1 = directives.createDirective({
      type: "contradiction",
      question: "Is the DB Postgres or MySQL?",
      priority: 0.9,
    });
    const d2 = directives.createDirective({
      type: "knowledge_gap",
      question: "What CI system is used?",
      priority: 0.7,
    });
    const d3 = directives.createDirective({
      type: "low_confidence",
      question: "Is the app on Kubernetes?",
      priority: 0.5,
    });

    // Resolve d1
    const resolved = directives.resolveDirective(d1!.id, "It's PostgreSQL 15");

    s.score("resolveDirective returns true", resolved, 1);

    // d1 should no longer appear in session directives
    const session = directives.getDirectivesForSession();
    s.score("resolved directive excluded from session", !session.some((d) => d.id === d1!.id), 1);

    // Verify resolution is stored
    const row = db
      .prepare("SELECT resolution, resolved_at FROM epistemic_directives WHERE id = ?")
      .get(d1!.id) as any;
    s.score(
      "resolution stored correctly",
      row?.resolution === "It's PostgreSQL 15" && row?.resolved_at !== null,
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(3);
  });

  it("Scenario 3: Deduplication (3 pts)", () => {
    const s = new ScenarioScorer("Deduplication", 3);

    const d1 = directives.createDirective({
      type: "contradiction",
      question: "Is the production DB Postgres or MySQL?",
      priority: 0.5,
    });

    // Create same question again with higher priority
    const d2 = directives.createDirective({
      type: "contradiction",
      question: "Is the production DB Postgres or MySQL?",
      priority: 0.9,
    });

    // Should be deduplicated: only 1 directive exists
    const count =
      (
        db
          .prepare("SELECT COUNT(*) as c FROM epistemic_directives WHERE resolved_at IS NULL")
          .get() as any
      )?.c ?? 0;

    s.score("only 1 unresolved directive exists (deduped)", count === 1, 1.5);

    // The surviving directive should have the higher priority
    const session = directives.getDirectivesForSession();
    s.score(
      "priority bumped to higher value",
      session.length >= 1 && (session[0]?.priority ?? 0) >= 0.9,
      1.5,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(3);
  });

  it("Scenario 4: Somatic marker assessment (3 pts)", () => {
    const s = new ScenarioScorer("Somatic Marker Assessment", 3);

    // Create high-cortisol, negative-steering chunks (danger zone)
    const cautionIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      cautionIds.push(
        insertChunk(db, {
          hormonal_cortisol: 0.8,
          steering_reward: -0.5,
          hormonal_dopamine: 0.1,
        }),
      );
    }

    const cautionResult = assessSomaticMarkers(db, cautionIds);
    s.score(
      "high cortisol + negative steering → 'caution'",
      cautionResult.verdict === "caution",
      1,
    );

    // Create high-dopamine, positive-steering chunks (trusted zone)
    const trustedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      trustedIds.push(
        insertChunk(db, {
          hormonal_dopamine: 0.8,
          steering_reward: 0.7,
          hormonal_cortisol: 0.1,
        }),
      );
    }

    const trustedResult = assessSomaticMarkers(db, trustedIds);
    s.score(
      "high dopamine + positive steering → 'trusted'",
      trustedResult.verdict === "trusted",
      1,
    );

    // Mixed chunks should get "proceed"
    const mixedIds = [cautionIds[0]!, trustedIds[0]!, insertChunk(db)];
    const mixedResult = assessSomaticMarkers(db, mixedIds);
    s.score("mixed signals → 'proceed'", mixedResult.verdict === "proceed", 1);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(3);
  });

  it("Scenario 5: Directive expiry (3 pts)", () => {
    const s = new ScenarioScorer("Directive Expiry", 3);

    // Create old directive (>30 days)
    db.prepare(
      `INSERT INTO epistemic_directives (id, directive_type, question, priority, created_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "old-1",
      "stale_fact",
      "Is this still true?",
      0.5,
      Date.now() - 31 * 24 * 60 * 60 * 1000,
      0,
    );

    // Create recent directive
    const recent = directives.createDirective({
      type: "knowledge_gap",
      question: "What's the deploy process?",
      priority: 0.7,
    });

    const expired = directives.expireOld();

    s.score("expireOld removes at least 1", expired >= 1, 1.5);

    // Recent should survive
    const remaining = db
      .prepare("SELECT COUNT(*) as c FROM epistemic_directives WHERE resolved_at IS NULL")
      .get() as any;

    s.score("recent directive survives expiry", remaining?.c >= 1, 1.5);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(3);
  });
});
