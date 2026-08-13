/**
 * The user profile feeds proactive recall, so what gets in matters.
 *
 * Live state on 2026-08-13: 251 stored preferences, 162 of them paraphrases of
 * the same three HEARTBEAT.md instructions. The heartbeat poll restates its own
 * protocol every cycle, the extractor turned each restatement into a
 * "directive", and because the storage key is derived from the first five
 * content words, every rewording minted a NEW row. Two guards: protocol
 * scaffolding is not a preference, and a restatement corroborates the row it
 * restates instead of adding another.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { directiveSimilarity, isProtocolScaffolding, UserModelManager } from "./user-model.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
});

const countPrefs = (): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM user_preferences`).get() as { c: number }).c;

describe("protocol scaffolding is not a preference", () => {
  it("recognises the exact phrasings that flooded the store", () => {
    for (const text of [
      "User's directive to read HEARTBEAT.md if it exists.",
      "User's directive to follow the contents of HEARTBEAT.md strictly.",
      "User's response when nothing needs attention is HEARTBEAT_OK.",
      "User's instruction: if nothing needs attention, to reply HEARTBEAT_OK.",
    ]) {
      expect(isProtocolScaffolding(text), text).toBe(true);
    }
  });

  it("does not swallow a real preference that happens to mention timing", () => {
    for (const text of [
      "The user prefers pnpm over npm.",
      "The user wants commits authored as VGIL77.",
      "The user checks in every morning.",
    ]) {
      expect(isProtocolScaffolding(text), text).toBe(false);
    }
  });

  it("stores nothing when the heartbeat restates itself repeatedly", () => {
    const manager = new UserModelManager(db);
    for (let i = 0; i < 20; i++) {
      manager.upsertFromDirective({
        text: `User's directive to read HEARTBEAT.md if it exists (poll ${i}).`,
        confidence: 0.6,
        sessionId: `session-${i}`,
      });
    }
    expect(countPrefs()).toBe(0);
  });
});

/**
 * Scope note, measured rather than assumed: the real heartbeat paraphrases
 * score 0.18-0.56 against each other, i.e. mostly BELOW this threshold. The
 * similarity guard would NOT have prevented the 162-row flood — the scaffolding
 * fence above is what does that work. The threshold stays conservative on
 * purpose: silently merging two genuinely different user directives is a worse
 * failure than storing one duplicate, so this is a secondary net for close
 * restatements only.
 */
describe("a restatement corroborates instead of duplicating", () => {
  it("scores close restatements high and unrelated directives low", () => {
    const a = "The user wants every commit authored as VGIL77 with a per-commit override.";
    const b = "The user wants every commit to be authored as VGIL77 with a per-commit override.";
    const c = "The user prefers dark mode in the dashboard.";
    expect(directiveSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
    expect(directiveSimilarity(a, c)).toBeLessThan(0.3);
  });

  it("keeps one row across rephrasings and raises its confidence", () => {
    const manager = new UserModelManager(db);
    manager.upsertFromDirective({
      text: "The user wants every commit authored as VGIL77 with a per-commit override.",
      confidence: 0.5,
      sessionId: "s1",
    });
    expect(countPrefs()).toBe(1);
    const before = (
      db.prepare(`SELECT confidence FROM user_preferences`).get() as { confidence: number }
    ).confidence;

    manager.upsertFromDirective({
      text: "The user wants every commit to be authored as VGIL77 with a per-commit override.",
      confidence: 0.5,
      sessionId: "s2",
    });
    manager.upsertFromDirective({
      text: "The user wants every commit authored as VGIL77 with a per-commit override please.",
      confidence: 0.5,
      sessionId: "s3",
    });

    expect(countPrefs(), "rephrasings must not mint new rows").toBe(1);
    const after = (
      db.prepare(`SELECT confidence FROM user_preferences`).get() as { confidence: number }
    ).confidence;
    expect(after, "repetition is corroboration").toBeGreaterThan(before);
  });

  it("still records a genuinely different directive", () => {
    const manager = new UserModelManager(db);
    manager.upsertFromDirective({
      text: "The user wants every commit authored as VGIL77.",
      confidence: 0.5,
      sessionId: "s1",
    });
    manager.upsertFromDirective({
      text: "The user prefers pnpm and never yarn for installing packages.",
      confidence: 0.5,
      sessionId: "s2",
    });
    expect(countPrefs()).toBe(2);
  });
});
