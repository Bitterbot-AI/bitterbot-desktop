import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  analyzeRequestFrequency,
  collapseSubsumedPhrases,
  extractNgrams,
  injectFrequencyTargets,
  tokenize,
  type FrequencySignal,
} from "./request-frequency-analyzer.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE curiosity_queries (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      query_embedding TEXT NOT NULL DEFAULT '[]',
      result_count INTEGER NOT NULL DEFAULT 0,
      top_score REAL NOT NULL DEFAULT 0,
      mean_score REAL NOT NULL DEFAULT 0,
      region_id TEXT,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE curiosity_targets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0,
      region_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

function addQuery(db: DatabaseSync, query: string, timestamp: number): void {
  db.prepare(`INSERT INTO curiosity_queries (id, query, timestamp) VALUES (?, ?, ?)`).run(
    crypto.randomUUID(),
    query,
    timestamp,
  );
}

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("request-frequency-analyzer", () => {
  describe("tokenize", () => {
    it("strips stopwords, lowercases, preserves technical tokens", () => {
      const tokens = tokenize("How does the React useState hook work?");
      expect(tokens).toEqual(["react", "usestate", "hook", "work"]);
    });

    it("keeps dotted and hyphenated technical terms", () => {
      const tokens = tokenize("next.js app-router server-components");
      expect(tokens).toContain("next.js");
      expect(tokens).toContain("app-router");
      expect(tokens).toContain("server-components");
    });
  });

  describe("extractNgrams", () => {
    it("extracts bigrams in order", () => {
      const grams = extractNgrams(["react", "usestate", "hook"], [2]);
      expect(grams).toEqual(["react usestate", "usestate hook"]);
    });

    it("extracts multiple orders", () => {
      const grams = extractNgrams(["a", "b", "c", "d"], [2, 3]);
      expect(grams).toEqual(["a b", "b c", "c d", "a b c", "b c d"]);
    });

    it("skips orders larger than token count", () => {
      const grams = extractNgrams(["a", "b"], [3]);
      expect(grams).toEqual([]);
    });
  });

  describe("collapseSubsumedPhrases", () => {
    it("keeps the longer phrase when a shorter one is subsumed", () => {
      const signals: FrequencySignal[] = [
        {
          phrase: "react hooks tutorial",
          count: 5,
          firstSeenAt: 0,
          lastSeenAt: 0,
          sampleQueries: [],
        },
        { phrase: "react hooks", count: 5, firstSeenAt: 0, lastSeenAt: 0, sampleQueries: [] },
      ];
      expect(collapseSubsumedPhrases(signals).map((s) => s.phrase)).toEqual([
        "react hooks tutorial",
      ]);
    });

    it("keeps unrelated phrases", () => {
      const signals: FrequencySignal[] = [
        { phrase: "react hooks", count: 5, firstSeenAt: 0, lastSeenAt: 0, sampleQueries: [] },
        { phrase: "vue composition", count: 4, firstSeenAt: 0, lastSeenAt: 0, sampleQueries: [] },
      ];
      expect(collapseSubsumedPhrases(signals)).toHaveLength(2);
    });
  });

  describe("analyzeRequestFrequency", () => {
    it("returns empty array on empty DB", () => {
      const db = createTestDb();
      const signals = analyzeRequestFrequency(db, { now });
      expect(signals).toEqual([]);
    });

    it("detects a phrase repeated across multiple queries", () => {
      const db = createTestDb();
      addQuery(db, "how do react hooks work", now - 1 * DAY);
      addQuery(db, "react hooks documentation", now - 2 * DAY);
      addQuery(db, "tutorial for react hooks", now - 3 * DAY);
      addQuery(db, "unrelated question about css", now - 1 * DAY);

      const signals = analyzeRequestFrequency(db, {
        now,
        minFrequency: 3,
        lookbackDays: 7,
      });

      expect(signals.length).toBeGreaterThan(0);
      expect(signals.map((s) => s.phrase)).toContain("react hooks");
    });

    it("respects the lookback window", () => {
      const db = createTestDb();
      addQuery(db, "react hooks one", now - 14 * DAY);
      addQuery(db, "react hooks two", now - 15 * DAY);
      addQuery(db, "react hooks three", now - 16 * DAY);

      const signals = analyzeRequestFrequency(db, {
        now,
        minFrequency: 3,
        lookbackDays: 7,
      });

      expect(signals).toEqual([]);
    });

    it("requires minFrequency to surface", () => {
      const db = createTestDb();
      addQuery(db, "react hooks one", now - 1 * DAY);
      addQuery(db, "react hooks two", now - 2 * DAY);

      const signals = analyzeRequestFrequency(db, {
        now,
        minFrequency: 3,
        lookbackDays: 7,
      });

      expect(signals).toEqual([]);
    });

    it("limits output to maxSignals", () => {
      const db = createTestDb();
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 3; j++) {
          addQuery(db, `topic${i} subtopic request`, now - (i + 1) * HOUR - j * HOUR);
        }
      }

      const signals = analyzeRequestFrequency(db, {
        now,
        minFrequency: 3,
        lookbackDays: 7,
        maxSignals: 2,
      });

      expect(signals.length).toBeLessThanOrEqual(2);
    });
  });

  describe("injectFrequencyTargets", () => {
    it("inserts a knowledge_gap curiosity_target per signal", () => {
      const db = createTestDb();
      const signals: FrequencySignal[] = [
        {
          phrase: "react hooks",
          count: 5,
          firstSeenAt: now - 3 * DAY,
          lastSeenAt: now - 1 * DAY,
          sampleQueries: ["how do react hooks work"],
        },
      ];

      const result = injectFrequencyTargets(db, signals, { ttlDays: 14, now });
      expect(result.injected).toBe(1);

      const rows = db
        .prepare(`SELECT type, description, metadata, priority FROM curiosity_targets`)
        .all() as Array<{ type: string; description: string; metadata: string; priority: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("knowledge_gap");
      expect(rows[0]?.description).toContain("react hooks");
      expect(rows[0]?.priority).toBeGreaterThan(0.3);
      expect(JSON.parse(rows[0]?.metadata ?? "{}")).toMatchObject({
        source: "request_frequency",
        phrase: "react hooks",
        count: 5,
      });
    });

    it("skips duplicates when an existing unresolved target covers the phrase", () => {
      const db = createTestDb();
      // Pre-seed an existing target.
      db.prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at) VALUES (?, 'knowledge_gap', ?, ?, '{}', ?, ?)`,
      ).run("pre-existing", "User-requested topic: react hooks", 0.5, now - 1 * DAY, now + 7 * DAY);

      const signals: FrequencySignal[] = [
        {
          phrase: "react hooks",
          count: 5,
          firstSeenAt: now - 3 * DAY,
          lastSeenAt: now - 1 * DAY,
          sampleQueries: [],
        },
      ];

      const result = injectFrequencyTargets(db, signals, { now });
      expect(result.injected).toBe(0);
      expect(result.skippedDueToDuplicate).toBe(1);
    });

    it("assigns higher priority to higher-frequency phrases", () => {
      const db = createTestDb();
      const signals: FrequencySignal[] = [
        {
          phrase: "barely popular",
          count: 3,
          firstSeenAt: 0,
          lastSeenAt: 0,
          sampleQueries: [],
        },
        { phrase: "very popular", count: 10, firstSeenAt: 0, lastSeenAt: 0, sampleQueries: [] },
      ];

      injectFrequencyTargets(db, signals, { now });
      const rows = db
        .prepare(`SELECT description, priority FROM curiosity_targets`)
        .all() as Array<{ description: string; priority: number }>;
      const veryPopular = rows.find((r) => r.description.includes("very popular"));
      const barelyPopular = rows.find((r) => r.description.includes("barely popular"));
      expect(veryPopular).toBeDefined();
      expect(barelyPopular).toBeDefined();
      expect(veryPopular!.priority).toBeGreaterThan(barelyPopular!.priority);
    });
  });
});
