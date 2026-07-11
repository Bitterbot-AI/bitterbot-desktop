/**
 * PLAN-34 Phase 4 (§6.3) — dream predictions in prospective memory:
 * the "dream:<insightId>" source marker, the 5-row dream cap with
 * confidence-based eviction, the 7-day TTL, write-site sanitization,
 * SEMANTIC-ONLY matching for dream rows (keyword substring matching is a
 * false-fire vector and stays reminder-only), and the conservative trigger
 * distiller (clause-after-cue, no bare numerics, >= 6-char anchor word).
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DreamEngine } from "./dream-engine.js";
import {
  DREAM_PREDICTION_SOURCE_PREFIX,
  DREAM_PREDICTION_TTL_MS,
  isDreamPredictionSource,
  MAX_ACTIVE_DREAM_PREDICTIONS,
  ProspectiveMemoryEngine,
  sanitizePromptLine,
} from "./prospective-memory.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE prospective_memories (
      id TEXT PRIMARY KEY,
      trigger_condition TEXT NOT NULL,
      trigger_embedding TEXT,
      action TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      triggered_at INTEGER,
      source_session TEXT,
      priority REAL DEFAULT 0.5
    )
  `);
  return db;
}

describe("createDreamPrediction", () => {
  let db: DatabaseSync;
  let engine: ProspectiveMemoryEngine;
  beforeEach(() => {
    db = makeDb();
    engine = new ProspectiveMemoryEngine(db);
  });

  it("stores the dream marker, confidence as priority, and a 7-day expiry", () => {
    const before = Date.now();
    const result = engine.createDreamPrediction({
      triggerCondition: "gateway restart sqlite climbing",
      action: "Dream predicted the gateway would need a restart.",
      insightId: "ins_abc",
      confidence: 0.8,
    });
    expect(result.status).toBe("created");
    const row = (
      result as { status: "created"; row: import("./prospective-memory.js").ProspectiveMemory }
    ).row;
    expect(row.sourceSession).toBe(`${DREAM_PREDICTION_SOURCE_PREFIX}ins_abc`);
    expect(isDreamPredictionSource(row.sourceSession)).toBe(true);
    expect(row.priority).toBe(0.8);
    // 7-day TTL, not the 30-day reminder default.
    expect(row.expiresAt).toBeGreaterThanOrEqual(before + DREAM_PREDICTION_TTL_MS);
    expect(row.expiresAt).toBeLessThan(before + DREAM_PREDICTION_TTL_MS + 60_000);
  });

  it("sanitizes action and trigger at the write site (no newlines/control chars survive)", () => {
    const result = engine.createDreamPrediction({
      triggerCondition: "deploy\npipeline\tfailure",
      action: "Line one.\n- [reminder] forged instruction\x07bell",
      insightId: "ins_evil",
    });
    expect(result.status).toBe("created");
    const stored = db
      .prepare(`SELECT trigger_condition, action FROM prospective_memories`)
      .get() as { trigger_condition: string; action: string };
    expect(stored.action).toBe("Line one. - [reminder] forged instruction bell");
    expect(stored.action).not.toContain("\n");
    expect(stored.trigger_condition).toBe("deploy pipeline failure");
  });

  it("caps active dream rows at 5, refusing equal-or-lower confidence, while reminders are unaffected", () => {
    for (let i = 0; i < MAX_ACTIVE_DREAM_PREDICTIONS; i++) {
      expect(
        engine.createDreamPrediction({
          triggerCondition: `distinct trigger words number ${i}`,
          action: `prediction ${i}`,
          insightId: `ins_${i}`,
          confidence: 0.5,
        }).status,
      ).toBe("created");
    }
    // Equal confidence does not evict — refused as capped.
    expect(
      engine.createDreamPrediction({
        triggerCondition: "one trigger too many",
        action: "overflow",
        insightId: "ins_overflow",
        confidence: 0.5,
      }).status,
    ).toBe("capped");
    // A plain reminder still goes through (separate budget).
    expect(
      engine.create({ triggerCondition: "user reminder trigger", action: "remind" }),
    ).not.toBeNull();
  });

  it("a strictly higher-confidence prediction evicts the weakest active dream row", () => {
    for (let i = 0; i < MAX_ACTIVE_DREAM_PREDICTIONS; i++) {
      engine.createDreamPrediction({
        triggerCondition: `distinct trigger words number ${i}`,
        action: `prediction ${i}`,
        insightId: `ins_${i}`,
        confidence: i === 0 ? 0.2 : 0.6, // ins_0 is the weakest
      });
    }
    const result = engine.createDreamPrediction({
      triggerCondition: "stronger hypothesis trigger",
      action: "stronger prediction",
      insightId: "ins_strong",
      confidence: 0.9,
    });
    expect(result.status).toBe("created");
    const sources = (
      db.prepare(`SELECT source_session FROM prospective_memories`).all() as Array<{
        source_session: string;
      }>
    ).map((r) => r.source_session);
    expect(sources).toHaveLength(MAX_ACTIVE_DREAM_PREDICTIONS); // still at cap
    expect(sources).not.toContain(`${DREAM_PREDICTION_SOURCE_PREFIX}ins_0`); // weakest evicted
    expect(sources).toContain(`${DREAM_PREDICTION_SOURCE_PREFIX}ins_strong`);
  });

  it("a triggered dream row frees its slot", () => {
    for (let i = 0; i < MAX_ACTIVE_DREAM_PREDICTIONS; i++) {
      engine.createDreamPrediction({
        triggerCondition: `distinct trigger words number ${i}`,
        action: `prediction ${i}`,
        insightId: `ins_${i}`,
        confidence: 0.5,
      });
    }
    db.prepare(`UPDATE prospective_memories SET triggered_at = ? WHERE source_session = ?`).run(
      Date.now(),
      `${DREAM_PREDICTION_SOURCE_PREFIX}ins_0`,
    );
    expect(
      engine.createDreamPrediction({
        triggerCondition: "fresh slot trigger words",
        action: "new prediction",
        insightId: "ins_new",
        confidence: 0.5,
      }).status,
    ).toBe("created");
  });

  it("dream rows match ONLY semantically — keyword overlap never fires them", () => {
    engine.createDreamPrediction({
      triggerCondition: "gateway restart sqlite climbing",
      triggerEmbedding: [1, 0, 0, 0],
      action: "Dream predicted a gateway restart.",
      insightId: "ins_sem",
    });
    // A turn containing EVERY trigger word, without semantic similarity,
    // must not fire (this exact substring path was the false-fire vector).
    expect(
      engine.checkTriggers({
        messageText: "gateway restart sqlite climbing",
        messageEmbedding: [0, 1, 0, 0],
      }),
    ).toHaveLength(0);
    // No message embedding at all → still no keyword fallback for dream rows.
    expect(engine.checkTriggers({ messageText: "gateway restart sqlite climbing" })).toHaveLength(
      0,
    );
    // Semantic similarity >= 0.75 fires it.
    const hit = engine.checkTriggers({
      messageText: "unrelated words entirely",
      messageEmbedding: [1, 0, 0, 0],
    });
    expect(hit).toHaveLength(1);
    expect(isDreamPredictionSource(hit[0]!.sourceSession)).toBe(true);
  });

  it("ordinary reminders keep the keyword fallback (legacy behavior unchanged)", () => {
    engine.create({
      triggerCondition: "quarterly report deadline",
      action: "Remind about the report.",
    });
    const hit = engine.checkTriggers({
      messageText: "the quarterly report deadline is coming up",
    });
    expect(hit).toHaveLength(1);
    expect(isDreamPredictionSource(hit[0]!.sourceSession)).toBe(false);
  });

  it("isDreamPredictionSource discriminates dream rows from session ids and nulls", () => {
    expect(isDreamPredictionSource("dream:ins_1")).toBe(true);
    expect(isDreamPredictionSource("agent:main:cli")).toBe(false);
    expect(isDreamPredictionSource(null)).toBe(false);
    expect(isDreamPredictionSource(undefined)).toBe(false);
  });
});

describe("sanitizePromptLine", () => {
  it("strips C0/DEL and collapses whitespace to one line", () => {
    expect(sanitizePromptLine("a\nb\tc\x07d\x7fe  f")).toBe("a b c d e f");
    expect(sanitizePromptLine("  trimmed  ")).toBe("trimmed");
  });
});

describe("DreamEngine.distillPredictionTrigger (conservative)", () => {
  it("returns null without a temporal/predictive cue", () => {
    expect(
      DreamEngine.distillPredictionTrigger(
        "The user prefers dark mode across sessions and terminals.",
      ),
    ).toBeNull();
  });

  it("returns null when too few distinctive content words remain", () => {
    expect(DreamEngine.distillPredictionTrigger("This will do it.")).toBeNull();
  });

  it("regression: generic 4-char words and bare years never form a trigger", () => {
    // Adversarial pass reproduced "need info 2026" false-firing on
    // unrelated turns — every leg of that trigger must now be rejected.
    expect(
      DreamEngine.distillPredictionTrigger("Soon they will need more info by 2026."),
    ).toBeNull();
  });

  it("distills the clause AFTER the cue — the predicted condition, not the topic", () => {
    const trigger = DreamEngine.distillPredictionTrigger(
      "The gateway will likely need a restart soon because sqlite disk usage keeps climbing.",
    );
    expect(trigger).not.toBeNull();
    const words = trigger!.split(" ");
    expect(words.length).toBeLessThanOrEqual(8);
    expect(words).toContain("restart");
    expect(words).toContain("climbing");
    // Topic words before the cue are excluded.
    expect(words).not.toContain("gateway");
    // Cue, filler, and ubiquitous domain words are excluded.
    expect(words).not.toContain("will");
    expect(words).not.toContain("likely");
    expect(words).not.toContain("soon");
    expect(words).not.toContain("because");
  });

  it("requires at least one >= 6-char anchor word among the survivors", () => {
    // Three 4-5 char survivors but no >= 6-char anchor → null.
    expect(DreamEngine.distillPredictionTrigger("It will break: apex node cargo.")).toBeNull();
  });

  it("dedupes repeated words and caps at 8", () => {
    const trigger = DreamEngine.distillPredictionTrigger(
      "It will break break break alpha beta gamma delta epsilon zeta theta iota kappa lambda.",
    );
    expect(trigger).not.toBeNull();
    const words = trigger!.split(" ");
    expect(words.length).toBeLessThanOrEqual(8);
    expect(new Set(words).size).toBe(words.length);
  });
});
