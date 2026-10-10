/**
 * PLAN-55 Phase 0: the owner's standing "no". The contract under test: the
 * three hash functions normalise what the background writers vary (case,
 * whitespace), add is idempotent on (kind, hash), lift removes exactly one
 * row, and a database that predates v76 reads as "nothing suppressed".
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import {
  addSuppression,
  chunkTextHash,
  factKeyValueHash,
  isSuppressed,
  liftSuppression,
  listSuppressions,
  preferenceKeyHash,
} from "./memory-suppressions.js";

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

describe("hashing", () => {
  it("chunk text: trim, collapse whitespace and case do not change the hash", () => {
    const a = chunkTextHash("The deploy endpoint is api.acme.com.");
    expect(chunkTextHash("  the   deploy\nendpoint is API.acme.com. ")).toBe(a);
    expect(chunkTextHash("The deploy endpoint is api2.acme.com.")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fact key/value: key and value are normalised separately and joined with NUL", () => {
    const a = factKeyValueHash("infra.deploy_endpoint", "api.acme.com");
    expect(factKeyValueHash(" Infra.Deploy_Endpoint ", "  API.acme.com ")).toBe(a);
    expect(factKeyValueHash("infra.deploy_endpoint", "api2.acme.com")).not.toBe(a);
    // Swapping key and value is a different pair.
    expect(factKeyValueHash("api.acme.com", "infra.deploy_endpoint")).not.toBe(a);
  });

  it("preference key: category and key, lowercased, NUL-joined, not hashed", () => {
    expect(preferenceKeyHash(" Language ", "Preferred_Language")).toBe(
      "language\u0000preferred_language",
    );
  });
});

describe("store", () => {
  it("adds once per (kind, hash) and keeps the first reason", () => {
    const first = addSuppression(db, { kind: "chunk_hash", hash: "h1", reason: "owner_forget" });
    const again = addSuppression(db, { kind: "chunk_hash", hash: "h1", reason: "other" });
    expect(again.id).toBe(first.id);
    expect(again.reason).toBe("owner_forget");
    expect(again.actor).toBe("owner");
    expect(listSuppressions(db)).toHaveLength(1);
  });

  it("the same hash under another kind is a different suppression", () => {
    addSuppression(db, { kind: "chunk_hash", hash: "same" });
    addSuppression(db, { kind: "fact_key_value", hash: "same" });
    expect(isSuppressed(db, "chunk_hash", "same")).not.toBeNull();
    expect(isSuppressed(db, "fact_key_value", "same")).not.toBeNull();
    expect(isSuppressed(db, "preference_key", "same")).toBeNull();
    expect(listSuppressions(db, { kind: "chunk_hash" })).toHaveLength(1);
    expect(listSuppressions(db)).toHaveLength(2);
  });

  it("lift removes exactly that row and reports whether one was there", () => {
    addSuppression(db, { kind: "preference_key", hash: "language\u0000preferred_language" });
    addSuppression(db, { kind: "preference_key", hash: "tool\u0000preferred_editor" });
    expect(liftSuppression(db, "preference_key", "language\u0000preferred_language")).toBe(true);
    expect(liftSuppression(db, "preference_key", "language\u0000preferred_language")).toBe(false);
    expect(isSuppressed(db, "preference_key", "language\u0000preferred_language")).toBeNull();
    expect(isSuppressed(db, "preference_key", "tool\u0000preferred_editor")).not.toBeNull();
  });

  it("a database without the table reads as nothing suppressed", () => {
    const bare = new DatabaseSync(":memory:");
    expect(isSuppressed(bare, "chunk_hash", "x")).toBeNull();
    expect(liftSuppression(bare, "chunk_hash", "x")).toBe(false);
    expect(listSuppressions(bare)).toEqual([]);
  });
});
