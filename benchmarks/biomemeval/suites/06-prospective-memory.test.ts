/**
 * BioMemEval Suite 6: Prospective Memory (10% weight)
 *
 * Tests "when X happens, do Y" event-triggered future recall —
 * the first prospective memory implementation in any agent memory system.
 *
 * Reference: McDaniel, M.A. & Einstein, G.O. (2007). Prospective memory.
 */

import type { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { ProspectiveMemoryEngine } from "../../../src/memory/prospective-memory.js";
import { createBenchmarkDb } from "../db-setup.js";
import { deterministicEmbedding, similarEmbedding, orthogonalEmbedding } from "../helpers.js";
import { ScenarioScorer, SuiteScorer } from "../scoring.js";

const suite = new SuiteScorer("Prospective Memory", "06-prospective", 10, 10);

describe("BioMemEval > Prospective Memory", () => {
  let db: DatabaseSync;
  let engine: ProspectiveMemoryEngine;

  beforeEach(() => {
    db = createBenchmarkDb();
    engine = new ProspectiveMemoryEngine(db);
  });

  it("Scenario 1: Keyword trigger (2 pts)", () => {
    const s = new ScenarioScorer("Keyword Trigger", 2);

    const pm = engine.create({
      triggerCondition: "deployment production staging ready",
      action: "Remind about staging tests before deploying",
    });

    s.score("prospective memory created", pm !== null, 0.5);

    // Trigger words >3 chars: ["deployment", "production", "staging", "ready"] (4 words)
    // Message words: includes "deployment" ✓, "production" ✓, "ready" ✓ = 3/4 = 75% >= 60%
    const triggered = engine.checkTriggers({
      messageText: "We're ready for the deployment to production",
    });

    s.score("keyword match triggers the memory", triggered.length === 1, 1);
    s.score(
      "triggered memory contains correct action",
      triggered[0]?.action?.includes("staging tests") ?? false,
      0.5,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(2);
  });

  it("Scenario 2: Semantic trigger (2 pts)", () => {
    const s = new ScenarioScorer("Semantic Trigger", 2);

    const triggerEmb = deterministicEmbedding("deployment-trigger");
    const pm = engine.create({
      triggerCondition: "deployment discussion",
      triggerEmbedding: triggerEmb,
      action: "Check staging before deploy",
    });

    s.score("prospective memory with embedding created", pm !== null, 0.5);

    // High similarity message should trigger
    const highSimEmb = similarEmbedding(triggerEmb, 0.85);
    const triggered = engine.checkTriggers({
      messageText: "Let's discuss the deploy plan",
      messageEmbedding: highSimEmb,
    });

    s.score("high-similarity message triggers", triggered.length >= 1, 0.75);

    // Low similarity message should NOT trigger (create a new PM for this test)
    engine.create({
      triggerCondition: "budget meeting",
      triggerEmbedding: deterministicEmbedding("budget-meeting"),
      action: "Bring Q1 numbers",
    });
    const lowSimEmb = orthogonalEmbedding(deterministicEmbedding("budget-meeting"));
    const notTriggered = engine.checkTriggers({
      messageText: "The weather is nice today",
      messageEmbedding: lowSimEmb,
    });

    s.score("low-similarity message does NOT trigger", notTriggered.length === 0, 0.75);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBeGreaterThanOrEqual(1.5);
  });

  it("Scenario 3: Expiration cleanup (2 pts)", () => {
    const s = new ScenarioScorer("Expiration Cleanup", 2);

    // Create expired PM
    engine.create({
      triggerCondition: "old trigger",
      action: "old action",
      expiresAt: Date.now() - 1000, // already expired
    });

    // Create non-expired PM
    engine.create({
      triggerCondition: "active trigger",
      action: "active action",
      expiresAt: Date.now() + 60_000,
    });

    engine.cleanExpired();

    // Check that the expired PM was actually removed from the DB
    const expiredRemaining = db
      .prepare(
        "SELECT COUNT(*) as c FROM prospective_memories WHERE expires_at IS NOT NULL AND expires_at < ?",
      )
      .get(Date.now()) as { c: number } | undefined;

    s.score("expired PM removed from database", (expiredRemaining?.c ?? 0) === 0, 1);

    // Active PM should still exist in the DB
    const activeRemaining = db
      .prepare(
        "SELECT COUNT(*) as c FROM prospective_memories WHERE triggered_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(Date.now()) as { c: number } | undefined;

    s.score("non-expired PM survives cleanup", (activeRemaining?.c ?? 0) >= 1, 1);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(2);
  });

  it("Scenario 4: Max active limit (2 pts)", () => {
    const s = new ScenarioScorer("Max Active Limit", 2);

    const smallEngine = new ProspectiveMemoryEngine(db, { maxActive: 3 });

    // Create 3 PMs (at capacity)
    for (let i = 0; i < 3; i++) {
      const pm = smallEngine.create({
        triggerCondition: `trigger ${i}`,
        action: `action ${i}`,
      });
      expect(pm).not.toBeNull();
    }

    // 4th should be rejected
    const overflow = smallEngine.create({
      triggerCondition: "overflow trigger",
      action: "overflow action",
    });

    s.score("creation at capacity is rejected (returns null)", overflow === null, 1);

    // Trigger one to free a slot
    smallEngine.checkTriggers({ messageText: "trigger 0" });

    // Now creation should succeed
    const afterFree = smallEngine.create({
      triggerCondition: "new trigger",
      action: "new action",
    });

    s.score("creation succeeds after slot freed", afterFree !== null, 1);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(2);
  });

  it("Scenario 5: No false positives (2 pts)", () => {
    const s = new ScenarioScorer("No False Positives", 2);

    const triggerEmb = deterministicEmbedding("very-specific-deployment-ci-pipeline");
    engine.create({
      triggerCondition: "CI pipeline deployment failure",
      triggerEmbedding: triggerEmb,
      action: "Check the CI logs",
    });

    const unrelatedMessages = [
      "What's for lunch today?",
      "The quarterly report looks good",
      "Can you help me with this CSS issue?",
      "I'm going on vacation next week",
      "The database backup completed successfully",
    ];

    let falsePositives = 0;
    for (const msg of unrelatedMessages) {
      const orthoEmb = orthogonalEmbedding(triggerEmb);
      const triggered = engine.checkTriggers({
        messageText: msg,
        messageEmbedding: orthoEmb,
      });
      if (triggered.length > 0) {
        falsePositives++;
      }
    }

    s.score("zero false positives across 5 unrelated messages", falsePositives === 0, 2);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(2);
  });
});
