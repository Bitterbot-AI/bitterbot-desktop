/**
 * PLAN-43 Phase 0: the flywheel-protecting separation.
 *
 * The paid listing pool is `chunks.for_sale = 1` — an explicit per-skill
 * opt-in — and is NEVER fed by the free propagation pool
 * (publish_visibility = 'shared'). Ranking is by PLAN-42 validation
 * verdicts (canonical corpus first), never by price or farmable counts.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { SkillValidationSummary } from "./skill-evolution/validation-summaries.js";
import { MarketplaceEconomics } from "./marketplace-economics.js";
import { ensureColumn, ensureMemoryIndexSchema } from "./memory-schema.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureColumn(db, "chunks", "publish_visibility", "TEXT");
  ensureColumn(db, "chunks", "published_at", "INTEGER");
  ensureColumn(db, "chunks", "for_sale", "INTEGER DEFAULT 0");
  ensureColumn(db, "chunks", "semantic_type", "TEXT");
  ensureColumn(db, "chunks", "skill_category", "TEXT");
  ensureColumn(db, "chunks", "download_count", "INTEGER DEFAULT 0");
  ensureColumn(db, "chunks", "marketplace_listed", "INTEGER DEFAULT 0");
  ensureColumn(db, "chunks", "stable_skill_id", "TEXT");
  ensureColumn(db, "chunks", "provenance_chain", "TEXT");
  ensureColumn(db, "chunks", "deprecated", "INTEGER DEFAULT 0");
  return db;
}

let nextExecId = 0;

function insertSkillChunk(
  db: DatabaseSync,
  id: string,
  name: string,
  opts: { forSale?: boolean; shared?: boolean } = {},
): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, semantic_type, publish_visibility, for_sale)
     VALUES (?, ?, 'memory', 0, 0, ?, 'test', ?, '[]', ?, 'skill', ?, ?)`,
  ).run(
    id,
    `skills/${id}`,
    `hash-${id}`,
    `${name}\nA test skill body.`,
    Date.now(),
    opts.shared ? "shared" : null,
    opts.forSale ? 1 : 0,
  );
}

/** Enough successful executions to pass the listing gates (>=3, >=60%). */
function recordPassingExecutions(db: DatabaseSync, crystalId: string): void {
  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO skill_executions (id, skill_crystal_id, started_at, success, reward_score, completed_at)
       VALUES (?, ?, ?, 1, 0.9, ?)`,
    ).run(`exec-${nextExecId++}`, crystalId, Date.now(), Date.now());
  }
}

describe("MarketplaceEconomics — PLAN-43 Phase 0 separation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("a free 'shared' skill is NOT a paid-listing candidate but STAYS browsable (I1/I2)", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-shared", "Shared Skill", { shared: true });
    recordPassingExecutions(db, "c-shared");

    const listed = economics.refreshListings(1.0);

    expect(listed).toBe(0);
    expect(economics.getListableSkills()).toEqual([]);
    const row = db
      .prepare(`SELECT * FROM marketplace_listings WHERE skill_crystal_id = ?`)
      .get("c-shared");
    expect(row).toBeUndefined();
    // Free discoverability (the browse layer) is independent of the paid
    // opt-in: the shared skill still gets its marketplace_listed flag.
    const chunk = db
      .prepare(`SELECT marketplace_listed FROM chunks WHERE id = ?`)
      .get("c-shared") as { marketplace_listed: number };
    expect(chunk.marketplace_listed).toBe(1);
  });

  it("an explicitly for-sale skill lists once it passes the gates", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-sale", "Sale Skill", { forSale: true });
    recordPassingExecutions(db, "c-sale");

    const listed = economics.refreshListings(1.0);

    expect(listed).toBe(1);
    const listings = economics.getListableSkills();
    expect(listings).toHaveLength(1);
    expect(listings[0]!.skillCrystalId).toBe("c-sale");
    // A skill can be BOTH free-propagated and for sale; neither implies the other.
  });

  it("clearing for_sale sweeps the listing on the next refresh", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-sweep", "Sweep Skill", { forSale: true });
    recordPassingExecutions(db, "c-sweep");
    economics.refreshListings(1.0);
    expect(economics.getListableSkills()).toHaveLength(1);

    db.prepare(`UPDATE chunks SET for_sale = 0 WHERE id = ?`).run("c-sweep");
    economics.refreshListings(1.0);

    expect(economics.getListableSkills()).toEqual([]);
    const row = db
      .prepare(
        `SELECT listable, listing_block_reason FROM marketplace_listings WHERE skill_crystal_id = ?`,
      )
      .get("c-sweep") as { listable: number; listing_block_reason: string };
    expect(row.listable).toBe(0);
    expect(row.listing_block_reason).toBe("not-for-sale");
    // Leaving the paid pool must NOT strip the free browse flag (I1).
    const chunk = db
      .prepare(`SELECT marketplace_listed FROM chunks WHERE id = ?`)
      .get("c-sweep") as { marketplace_listed: number };
    expect(chunk.marketplace_listed).toBe(1);
  });

  it("sweeps leftover listable rows from the pre-Phase-0 'shared' pool era", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-legacy", "Legacy Skill", { shared: true });
    // Simulate a row written before the for_sale decoupling.
    db.prepare(
      `INSERT INTO marketplace_listings
         (skill_crystal_id, name, description, price_usdc, listable, updated_at)
       VALUES ('c-legacy', 'Legacy Skill', '', 0.05, 1, ?)`,
    ).run(Date.now());

    economics.refreshListings(1.0);

    const row = db
      .prepare(
        `SELECT listable, listing_block_reason FROM marketplace_listings WHERE skill_crystal_id = ?`,
      )
      .get("c-legacy") as { listable: number; listing_block_reason: string };
    expect(row.listable).toBe(0);
    expect(row.listing_block_reason).toBe("not-for-sale");
  });

  it("setForSale opts in, rejects non-skill crystals, and delists immediately", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-optin", "Optin Skill");
    recordPassingExecutions(db, "c-optin");

    expect(economics.setForSale("missing", true)).toMatchObject({ ok: false });

    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, semantic_type)
       VALUES ('c-fact', 'f', 'memory', 0, 0, 'h', 'test', 'A fact', '[]', 0, 'fact')`,
    ).run();
    expect(economics.setForSale("c-fact", true)).toMatchObject({ ok: false });

    // Peer-imported crystals are refused until provenance-split wiring
    // exists (Phase 1) — a sale must never silently keep 100% (I4).
    insertSkillChunk(db, "c-peer", "Peer Skill");
    db.prepare(`UPDATE chunks SET governance_json = ? WHERE id = 'c-peer'`).run(
      JSON.stringify({ accessScope: "shared", peerOrigin: "12D3KooWpeer" }),
    );
    expect(economics.setForSale("c-peer", true)).toMatchObject({ ok: false });
    expect(economics.setForSale("c-peer", true).reason).toContain("peer-origin");

    expect(economics.setForSale("c-optin", true)).toEqual({ ok: true, forSale: true });
    economics.refreshListings(1.0);
    expect(economics.getListableSkills()).toHaveLength(1);

    // Delisting takes effect immediately, not at the next refresh.
    expect(economics.setForSale("c-optin", false)).toEqual({ ok: true, forSale: false });
    expect(economics.getListableSkills()).toEqual([]);
    const chunk = db.prepare(`SELECT for_sale FROM chunks WHERE id = ?`).get("c-optin") as {
      for_sale: number;
    };
    expect(chunk.for_sale).toBe(0);
  });

  it("ranks by validation verdicts — canonical first, never by price (I6/I10)", () => {
    const validations = new Map<string, SkillValidationSummary>([
      [
        "canonical-skill",
        {
          skillName: "canonical-skill",
          mode: "tasks",
          verdict: "accepted",
          meanDelta: 0.1,
          corpusVersion: "canonical-abc123+def456",
          validatedAt: Date.now(),
          canonical: true,
        },
      ],
      [
        "grown-skill",
        {
          skillName: "grown-skill",
          mode: "tasks",
          verdict: "accepted",
          meanDelta: 0.4,
          corpusVersion: "def456",
          validatedAt: Date.now(),
          canonical: false,
        },
      ],
    ]);
    const economics = new MarketplaceEconomics(db, undefined, {
      validationLookup: () => validations,
    });

    insertSkillChunk(db, "c-canon", "Canonical Skill", { forSale: true });
    insertSkillChunk(db, "c-grown", "Grown Skill", { forSale: true });
    insertSkillChunk(db, "c-none", "Unvalidated Skill", { forSale: true });
    for (const id of ["c-canon", "c-grown", "c-none"]) {
      recordPassingExecutions(db, id);
    }
    // Give the unvalidated skill the highest demand signal so a
    // price-ordered ranking would put it first.
    db.prepare(`UPDATE chunks SET download_count = 500 WHERE id = 'c-none'`).run();

    economics.refreshListings(1.0);
    const listings = economics.getListableSkills();

    expect(listings.map((l) => l.skillCrystalId)).toEqual(["c-canon", "c-grown", "c-none"]);
    expect(listings[0]!.validation).toMatchObject({
      verdict: "accepted",
      canonical: true,
      corpusVersion: "canonical-abc123+def456",
    });
    expect(listings[1]!.validation).toMatchObject({ canonical: false });
    expect(listings[2]!.validation).toBeUndefined();
  });
});
