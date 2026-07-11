/**
 * PLAN-34 Phase 2c — deterministic egress-safety guards. All LLM-free by
 * design: the sensitivity skip-list fails closed, the containment
 * post-filter is a hard check on the depersonalization OUTPUT, the daily
 * budget is a persisted reserve-then-act counter.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AutoResearchBudget,
  containsSourceLeak,
  isSensitiveTopic,
  logResearchEgress,
} from "./auto-research-egress.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("isSensitiveTopic", () => {
  it("blocks a representative target per category", () => {
    expect(isSensitiveTopic("compare medication options for my diagnosis")).toBe(true); // health
    expect(isSensitiveTopic("how to restructure my mortgage and debt")).toBe(true); // financial
    expect(isSensitiveTopic("prepare for the custody lawsuit hearing")).toBe(true); // legal
    expect(isSensitiveTopic("gift ideas after the breakup with my girlfriend")).toBe(true); // relationship
  });

  it("passes ordinary technical topics", () => {
    expect(isSensitiveTopic("Next.js App Router route handlers")).toBe(false);
    expect(isSensitiveTopic("SQLite WAL mode concurrent writers")).toBe(false);
  });
});

describe("containsSourceLeak", () => {
  const source =
    "New frontier opened by dream insight: Victor Gil ships a2a.bitterbot.ai gateway v2 " +
    "with 154 pending tasks — see https://internal.example.com/notes and mail bob@corp.example";

  it("rejects any 3-word gram of the output that appears verbatim in the source", () => {
    expect(containsSourceLeak(source, "frontier opened by dream research")).toBe(true);
    expect(containsSourceLeak(source, "study of pending tasks generally")).toBe(false);
  });

  it("rejects surviving entities: URL, email, number, capitalized name bigram", () => {
    expect(containsSourceLeak(source, "docs at https://internal.example.com/notes")).toBe(true);
    expect(containsSourceLeak(source, "ask bob@corp.example about it")).toBe(true);
    expect(containsSourceLeak(source, "queue depth 154 analysis")).toBe(true);
    expect(containsSourceLeak(source, "work by Victor Gil on gateways")).toBe(true);
  });

  it("passes a genuinely neutral rewrite", () => {
    expect(containsSourceLeak(source, "agent gateway task queue design patterns")).toBe(false);
  });
});

describe("AutoResearchBudget", () => {
  function makeDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    return db;
  }

  it("reserve-then-act: counts before work, caps at maxPerDay, persists across instances", () => {
    const db = makeDb();
    const a = new AutoResearchBudget(db, 2);
    expect(a.reserve()).toBe(true);
    expect(a.reserve()).toBe(true);
    expect(a.reserve()).toBe(false); // cap
    // A fresh instance over the same DB (a restart) sees the spent budget.
    const b = new AutoResearchBudget(db, 2);
    expect(b.usedToday()).toBe(2);
    expect(b.reserve()).toBe(false);
  });

  it("keys by UTC day: a new day gets a fresh budget and old keys are pruned", () => {
    const db = makeDb();
    const budget = new AutoResearchBudget(db, 1);
    const day1 = Date.UTC(2026, 6, 10, 12);
    const day2 = Date.UTC(2026, 6, 20, 12);
    expect(budget.reserve(day1)).toBe(true);
    expect(budget.reserve(day1)).toBe(false);
    expect(budget.reserve(day2)).toBe(true); // fresh day
    const stale = db
      .prepare(`SELECT COUNT(*) AS c FROM memory_meta WHERE key = 'autoresearch_count_2026-07-10'`)
      .get() as { c: number };
    expect(stale.c).toBe(0); // pruned (older than retention)
  });
});

describe("logResearchEgress", () => {
  it("writes one row per seam with destination and payload hash/length", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    logResearchEgress(db, "search-query", "web-search", "neutral phrase");
    logResearchEgress(db, "fetch-host", "docs.example.com", "https://docs.example.com/x");
    const rows = db
      .prepare(`SELECT seam, destination, payload_len FROM research_egress_log ORDER BY seam`)
      .all() as Array<{ seam: string; destination: string; payload_len: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seam: "fetch-host", destination: "docs.example.com" });
    expect(rows[1]).toMatchObject({ seam: "search-query", payload_len: "neutral phrase".length });
  });
});
