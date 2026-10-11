/**
 * PLAN-55 Phase 2, consumer 6: dream insights that state a superseded value
 * or rest on superseded / owner-forgotten evidence are flagged and never
 * promoted.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import { insightPromotionBlock, propagateToDreamInsights } from "./canonical-supersede-insights.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

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

function insight(id: string, content: string, sources: string[] = []): void {
  db.prepare(
    `INSERT INTO dream_insights (id, content, embedding, source_chunk_ids, dream_cycle_id,
       created_at, updated_at)
     VALUES (?, ?, '[]', ?, 'cycle', 1, 1)`,
  ).run(id, content, JSON.stringify(sources));
}

const flag = (id: string): Record<string, unknown> | null => {
  const row = db.prepare(`SELECT stale_fact FROM dream_insights WHERE id = ?`).get(id) as {
    stale_fact: string | null;
  };
  return row.stale_fact ? (JSON.parse(row.stale_fact) as Record<string, unknown>) : null;
};

const event = (over: Partial<CanonicalChangeEvent>): CanonicalChangeEvent => ({
  key: "infra.deploy_endpoint",
  oldValue: "api.acme.com",
  newValue: "api2.acme.com",
  op: "supersede",
  tier: 3,
  source: "owner",
  scope: "global",
  evidence: { ref: null, chunkIds: [] },
  factId: "fact-2",
  at: 1_000,
  ...over,
});

describe("dream insight propagation", () => {
  it("flags insights stating the old value or resting on a superseded chunk", async () => {
    insight("states", "Deploys to api.acme.com tend to fail on Fridays.");
    insight("rests", "Fridays are risky.", ["chunk-old"]);
    insight("clean", "The owner likes tea.", ["chunk-other"]);
    insight("both", "Moved from api.acme.com to api2.acme.com.");
    db.prepare(
      `INSERT INTO chunk_supersessions (chunk_id, fact_key, stale_value, created_at)
       VALUES ('chunk-old', 'infra.deploy_endpoint', 'api.acme.com', 1)`,
    ).run();
    const r = await propagateToDreamInsights(db, event({}));
    expect(r.flagged).toBe(2);
    expect(flag("states")).toMatchObject({ reason: "superseded", key: "infra.deploy_endpoint" });
    expect(flag("rests")).toMatchObject({ reason: "superseded" });
    expect(flag("clean")).toBeNull();
    expect(flag("both")).toBeNull();
    // Idempotent.
    expect((await propagateToDreamInsights(db, event({}))).flagged).toBe(0);
  });

  it("a pin back to the old value clears the flags it wrote", async () => {
    insight("states", "Deploys to api.acme.com tend to fail.");
    await propagateToDreamInsights(db, event({}));
    const back = await propagateToDreamInsights(
      db,
      event({ oldValue: "api2.acme.com", newValue: "api.acme.com" }),
    );
    expect(back.cleared).toBe(1);
    expect(flag("states")).toBeNull();
  });

  it("ignores soft retires", async () => {
    insight("states", "Deploys to api.acme.com tend to fail.");
    await propagateToDreamInsights(
      db,
      event({ op: "retire", newValue: null, retireReason: "decay" }),
    );
    expect(flag("states")).toBeNull();
  });
});

describe("insightPromotionBlock", () => {
  it("blocks flagged insights, superseded evidence and owner-forgotten evidence", () => {
    insight("ok", "Fine.", ["c1", "c2"]);
    expect(insightPromotionBlock(db, { id: "ok", sourceChunkIds: ["c1", "c2"] })).toBeNull();

    insight("flagged", "x");
    db.prepare(
      `UPDATE dream_insights SET stale_fact = '{"reason":"superseded"}' WHERE id = 'flagged'`,
    ).run();
    expect(insightPromotionBlock(db, { id: "flagged", sourceChunkIds: [] })).toBe("stale_fact");

    db.prepare(
      `INSERT INTO chunk_supersessions (chunk_id, fact_key, stale_value, created_at)
       VALUES ('c3', 'k.x', 'v', 1)`,
    ).run();
    insight("sup", "y", ["c1", "c3"]);
    expect(insightPromotionBlock(db, { id: "sup", sourceChunkIds: ["c1", "c3"] })).toBe(
      "superseded_evidence",
    );

    db.prepare(
      `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
       VALUES ('a1', 'c4', 'owner_forget', 1, 'owner', '{}')`,
    ).run();
    insight("forgot", "z", ["c1", "c4"]);
    expect(insightPromotionBlock(db, { id: "forgot", sourceChunkIds: ["c1", "c4"] })).toBe(
      "forgotten_evidence",
    );
    expect(flag("forgot")).toMatchObject({ reason: "forgotten_evidence", chunkIds: ["c4"] });
    // The flag now short-circuits.
    expect(insightPromotionBlock(db, { id: "forgot", sourceChunkIds: [] })).toBe("stale_fact");
  });
});
