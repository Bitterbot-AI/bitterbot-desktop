import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { briefIsWorthSending, buildDreamBrief, renderDreamBrief } from "./dream-brief.js";
import { ensureDreamSchema } from "./dream-schema.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { UserModelManager } from "./user-model.js";

let db: DatabaseSync;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const since = now - DAY;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureDreamSchema(db);
  new UserModelManager(db);
});

describe("buildDreamBrief", () => {
  it("is empty and not worth sending on a quiet day", () => {
    const brief = buildDreamBrief(db, since);
    expect(brief).toMatchObject({
      cycles: 0,
      insights: [],
      facts: [],
      preferences: [],
      openLoops: [],
    });
    expect(briefIsWorthSending(brief)).toBe(false);
  });

  it("collects today's dreams, insights and preference changes, and leaves yesterday's out", () => {
    db.prepare(
      "INSERT INTO dream_cycles (cycle_id, started_at, state) VALUES ('c1', ?, 'DONE'), ('c0', ?, 'DONE')",
    ).run(now - 1000, now - 2 * DAY);
    db.prepare(
      "INSERT INTO dream_insights (id, content, embedding, confidence, mode, dream_cycle_id, created_at, updated_at) VALUES ('i1', 'You plan trips around food more than sights.', '[]', 0.9, 'replay', 'c1', ?, ?), ('i0', 'old', '[]', 0.99, 'replay', 'c0', ?, ?)",
    ).run(now - 500, now - 500, now - 2 * DAY, now - 2 * DAY);
    db.prepare(
      "INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at) VALUES ('p', 'style', 'tone', 'brief and direct', 0.8, '[]', ?, ?)",
    ).run(now - 100, now - 100);

    const brief = buildDreamBrief(db, since);

    expect(brief.cycles).toBe(1);
    expect(brief.insights.map((i) => i.content)).toEqual([
      "You plan trips around food more than sights.",
    ]);
    expect(briefIsWorthSending(brief)).toBe(true);
    const text = renderDreamBrief(brief);
    expect(text).toContain("Overnight I dreamed 1 time.");
    expect(text).toContain("- You plan trips around food more than sights.");
    expect(text).toContain("- tone: brief and direct");
    expect(text).toContain("Memory page");
  });

  it("reports new and retired facts about the owner", () => {
    const add = db.prepare(
      "INSERT INTO canonical_facts (id, key, value, statement, category, confidence, first_seen_at, last_confirmed_at, valid_from, valid_until, source, status) VALUES (?, ?, ?, ?, 'personal', 0.9, ?, 0, ?, ?, 'test', ?)",
    );
    add.run("f1", "home.city", "Austin", "Lives in Austin", now - 100, now - 100, null, "active");
    add.run(
      "f0",
      "home.city",
      "Denver",
      "Lives in Denver",
      now - 30 * DAY,
      now - 30 * DAY,
      now - 100,
      "superseded",
    );
    add.run("f9", "pet", "cat", "Has a cat", now - 30 * DAY, now - 30 * DAY, null, "active");

    const brief = buildDreamBrief(db, since);

    expect(brief.facts).toEqual([
      { statement: "Lives in Austin", change: "new" },
      { statement: "Lives in Denver", change: "retired" },
    ]);
    const text = renderDreamBrief(brief);
    expect(text).toContain("- Now: Lives in Austin");
    expect(text).toContain("- No longer: Lives in Denver");
  });
});
