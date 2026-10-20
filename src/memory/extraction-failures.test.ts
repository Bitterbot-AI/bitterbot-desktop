import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearExtractionFailure,
  listExtractionFailures,
  readExtractionFailure,
  recordExtractionFailure,
  shouldSkipExtraction,
} from "./extraction-failures.js";

describe("session extraction failure ledger", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("a transcript is retried at most maxAttempts times per content hash, then parked", () => {
    const p = "/s/a.jsonl";
    expect(shouldSkipExtraction(db, p, "h1", { maxAttempts: 2, now: 10 })).toBe(false);
    recordExtractionFailure(db, p, "h1", "truncated", 1);
    expect(shouldSkipExtraction(db, p, "h1", { maxAttempts: 2, now: 10 })).toBe(false);
    const second = recordExtractionFailure(db, p, "h1", "truncated", 2);
    expect(second.attempts).toBe(2);
    expect(shouldSkipExtraction(db, p, "h1", { maxAttempts: 2, now: 10 })).toBe(true);
  });

  it("a changed content hash resets the attempt count", () => {
    const p = "/s/a.jsonl";
    recordExtractionFailure(db, p, "h1", "x", 1);
    recordExtractionFailure(db, p, "h1", "x", 2);
    expect(shouldSkipExtraction(db, p, "h2", { maxAttempts: 2, now: 10 })).toBe(false);
    expect(recordExtractionFailure(db, p, "h2", "x", 3).attempts).toBe(1);
  });

  it("a parked transcript gets one more attempt after retryAfterMs", () => {
    const p = "/s/a.jsonl";
    recordExtractionFailure(db, p, "h1", "x", 1_000);
    recordExtractionFailure(db, p, "h1", "x", 2_000);
    expect(
      shouldSkipExtraction(db, p, "h1", { maxAttempts: 2, retryAfterMs: 10_000, now: 5_000 }),
    ).toBe(true);
    expect(
      shouldSkipExtraction(db, p, "h1", { maxAttempts: 2, retryAfterMs: 10_000, now: 13_000 }),
    ).toBe(false);
  });

  it("a success clears the row; the ledger lists parked transcripts", () => {
    recordExtractionFailure(db, "/s/a.jsonl", "h1", "x", 1);
    recordExtractionFailure(db, "/s/b.jsonl", "h1", "y", 2);
    expect(listExtractionFailures(db).map((r) => r.session_path)).toEqual([
      "/s/b.jsonl",
      "/s/a.jsonl",
    ]);
    clearExtractionFailure(db, "/s/a.jsonl");
    expect(readExtractionFailure(db, "/s/a.jsonl")).toBeNull();
    expect(readExtractionFailure(db, "/s/b.jsonl")?.last_error).toBe("y");
  });
});
