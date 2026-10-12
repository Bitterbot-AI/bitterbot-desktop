/**
 * PLAN-55 Phase 2, consumer 3: the learned preference that mirrors a
 * canonical key follows the ledger, and never revives what the owner removed.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import {
  preferenceMatchesCanonicalKey,
  propagateToPreferences,
} from "./canonical-supersede-preferences.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { addSuppression, preferenceKeyHash, preferenceValueHash } from "./memory-suppressions.js";
import { UserModelManager } from "./user-model.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  new UserModelManager(db); // creates user_preferences
});

function pref(category: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO user_preferences (id, category, key, value, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0.8, 1, 1)`,
  ).run(`${category}:${key}`, category, key, value);
}

const value = (category: string, key: string): string | undefined =>
  (
    db
      .prepare(`SELECT value FROM user_preferences WHERE category = ? AND key = ?`)
      .get(category, key) as { value: string } | undefined
  )?.value;

const event = (over: Partial<CanonicalChangeEvent>): CanonicalChangeEvent => ({
  key: "identity.user_name",
  oldValue: "Vic",
  newValue: "Victor",
  op: "supersede",
  tier: 3,
  source: "owner",
  scope: "global",
  evidence: { ref: null, chunkIds: [] },
  factId: "f",
  at: 5_000,
  ...over,
});

describe("preference propagation", () => {
  it("maps <category>.<key> with . _ - treated alike", () => {
    expect(preferenceMatchesCanonicalKey("identity", "user_name", "identity.user.name")).toBe(true);
    expect(preferenceMatchesCanonicalKey("identity", "user-name", "identity.user_name")).toBe(true);
    expect(preferenceMatchesCanonicalKey("identity", "user_name", "identity.user_age")).toBe(false);
    expect(preferenceMatchesCanonicalKey("tool", "user_name", "identity.user_name")).toBe(false);
  });

  it("updates the matching row to the new value, idempotently", () => {
    pref("identity", "user_name", "Vic");
    pref("identity", "user_city", "Boston");
    expect(propagateToPreferences(db, event({}))).toEqual({ updated: 1, removed: 0 });
    expect(value("identity", "user_name")).toBe("Victor");
    expect(value("identity", "user_city")).toBe("Boston");
    expect(propagateToPreferences(db, event({}))).toEqual({ updated: 0, removed: 0 });
  });

  it("never creates a row, and background tiers do not overwrite", () => {
    expect(propagateToPreferences(db, event({}))).toEqual({ updated: 0, removed: 0 });
    expect(value("identity", "user_name")).toBeUndefined();
    pref("identity", "user_name", "Vic");
    propagateToPreferences(db, event({ tier: 0, source: "promotion" }));
    expect(value("identity", "user_name")).toBe("Vic");
  });

  it("removes the row on the owner's retire only when it still holds the retired value", () => {
    pref("identity", "user_name", "Vic");
    const retire = event({ op: "retire", newValue: null, retireReason: "owner" });
    propagateToPreferences(db, { ...retire, retireReason: "agent" });
    expect(value("identity", "user_name")).toBe("Vic");
    propagateToPreferences(db, { ...retire, oldValue: "Someone else" });
    expect(value("identity", "user_name")).toBe("Vic");
    expect(propagateToPreferences(db, retire)).toEqual({ updated: 0, removed: 1 });
    expect(value("identity", "user_name")).toBeUndefined();
  });

  it("removes instead of writing a value or key the owner suppressed", () => {
    pref("identity", "user_name", "Vic");
    addSuppression(db, {
      kind: "preference_value",
      hash: preferenceValueHash("identity", "Victor"),
    });
    expect(propagateToPreferences(db, event({}))).toEqual({ updated: 0, removed: 1 });
    pref("identity", "user_name", "Vic");
    db.prepare(`DELETE FROM memory_suppressions`).run();
    addSuppression(db, {
      kind: "preference_key",
      hash: preferenceKeyHash("identity", "user_name"),
    });
    expect(propagateToPreferences(db, event({}))).toEqual({ updated: 0, removed: 1 });
  });
});
