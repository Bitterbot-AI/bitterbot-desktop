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
import { contentSha256 } from "./lineage-gate.js";
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

  it("setForSale refuses a laundered near-duplicate of a commons skill and records the refusal (§3.3)", () => {
    const economics = new MarketplaceEconomics(db);
    // A peer-origin commons skill with an embedding.
    insertSkillChunk(db, "c-commons", "Commons Skill");
    db.prepare(`UPDATE chunks SET embedding = ?, governance_json = ? WHERE id = 'c-commons'`).run(
      JSON.stringify([1, 0, 0, 0]),
      JSON.stringify({ accessScope: "shared", peerOrigin: "pk-alice" }),
    );
    // A reworded copy with a near-identical embedding and no cited lineage.
    insertSkillChunk(db, "c-launder", "Commons Skill Rewritten");
    db.prepare(`UPDATE chunks SET embedding = ? WHERE id = 'c-launder'`).run(
      JSON.stringify([0.99, 0.14, 0, 0]),
    );
    recordPassingExecutions(db, "c-launder");

    const refused = economics.setForSale("c-launder", true);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("near-duplicate");
    const row = db
      .prepare(`SELECT nearest_id, similarity FROM listing_refusals WHERE skill_crystal_id = ?`)
      .get("c-launder") as { nearest_id: string; similarity: number };
    expect(row.nearest_id).toBe("c-commons");
    expect(row.similarity).toBeGreaterThan(0.9);
    // Never opted in.
    const chunk = db.prepare(`SELECT for_sale FROM chunks WHERE id = 'c-launder'`).get() as {
      for_sale: number;
    };
    expect(chunk.for_sale).toBe(0);

    // Citing the source's author as lineage clears the gate.
    db.prepare(`UPDATE chunks SET provenance_chain = ? WHERE id = 'c-launder'`).run(
      JSON.stringify(["pk-alice"]),
    );
    expect(economics.setForSale("c-launder", true)).toEqual({ ok: true, forSale: true });
    economics.refreshListings(1.0);
    expect(economics.getListableSkills()[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeRevenueShares owes the registry its royalty on an imported skill (I4)", () => {
    const economics = new MarketplaceEconomics(db, undefined, {
      registryRoyalty: {
        royaltyBps: 500, // 5%
        lookup: () => new Map([["imported-skill", { registry: "agentskills.io" }]]),
      },
    });
    insertSkillChunk(db, "c-import", "Imported Skill");
    insertSkillChunk(db, "c-mine", "My Own Skill");

    const imported = economics.computeRevenueShares("c-import", 1.0);
    const royalty = imported.find((s) => s.role === "registry_royalty");
    expect(royalty).toEqual({
      role: "registry_royalty",
      peerId: "agentskills.io",
      amountUsdc: 0.05,
    });
    expect(imported.reduce((a, s) => a + s.amountUsdc, 0)).toBeCloseTo(1.0, 9);
    expect(imported.find((s) => s.role === "publisher")?.amountUsdc).toBeCloseTo(0.95, 9);

    // A non-imported skill is unaffected.
    const own = economics.computeRevenueShares("c-mine", 1.0);
    expect(own).toEqual([{ role: "publisher", peerId: "local", amountUsdc: 1.0 }]);
  });

  it("setForSale `lineage` merges (never erases) the chain, restores it on refusal, and the split pays the EVIDENCE author", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-src", "Source Skill");
    db.prepare(`UPDATE chunks SET embedding = ?, governance_json = ? WHERE id = 'c-src'`).run(
      JSON.stringify([1, 0, 0, 0]),
      JSON.stringify({ accessScope: "shared", peerOrigin: "pk-alice" }),
    );
    insertSkillChunk(db, "c-deriv", "Source Skill Improved");
    db.prepare(`UPDATE chunks SET embedding = ?, provenance_chain = ? WHERE id = 'c-deriv'`).run(
      JSON.stringify([0.99, 0.14, 0, 0]),
      JSON.stringify(["pk-contributor"]),
    );
    recordPassingExecutions(db, "c-deriv");

    // Citing the wrong author: refused, and the pre-existing chain survives untouched.
    const refused = economics.setForSale("c-deriv", true, { lineage: ["pk-mallory"] });
    expect(refused.ok).toBe(false);
    expect(
      (
        db.prepare(`SELECT provenance_chain FROM chunks WHERE id = 'c-deriv'`).get() as {
          provenance_chain: string;
        }
      ).provenance_chain,
    ).toBe(JSON.stringify(["pk-contributor"]));

    // Citing the real author: allowed; the chain is a UNION (contributor kept).
    expect(economics.setForSale("c-deriv", true, { lineage: ["pk-alice"] })).toEqual({
      ok: true,
      forSale: true,
    });
    const chain = JSON.parse(
      (
        db.prepare(`SELECT provenance_chain FROM chunks WHERE id = 'c-deriv'`).get() as {
          provenance_chain: string;
        }
      ).provenance_chain,
    ) as string[];
    expect(chain).toEqual(["pk-alice", "pk-contributor"]);
    const listing = db
      .prepare(
        `SELECT lineage_author_pubkey FROM marketplace_listings WHERE skill_crystal_id = 'c-deriv'`,
      )
      .get() as { lineage_author_pubkey: string };
    expect(listing.lineage_author_pubkey).toBe("pk-alice");

    // Evidence beats a seller-rewritten chain head: even after the seller
    // moves their own second identity to the front, the author share goes to pk-alice.
    db.prepare(`UPDATE chunks SET provenance_chain = ? WHERE id = 'c-deriv'`).run(
      JSON.stringify(["pk-seller-alt", "pk-contributor"]),
    );
    const shares = economics.computeRevenueShares("c-deriv", 1.0);
    expect(shares.find((x) => x.role === "original_author")?.peerId).toBe("pk-alice");
    expect(shares.reduce((a, x) => a + x.amountUsdc, 0)).toBeCloseTo(1.0, 9);
  });

  it("refreshListings re-runs the gate and pulls a listing whose commons gained a matching source", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-first", "First Mover");
    db.prepare(`UPDATE chunks SET embedding = ? WHERE id = 'c-first'`).run(
      JSON.stringify([0.99, 0.14, 0, 0]),
    );
    recordPassingExecutions(db, "c-first");
    expect(economics.setForSale("c-first", true)).toEqual({ ok: true, forSale: true });
    economics.refreshListings(1.0);
    expect(economics.getListableSkills()).toHaveLength(1);

    // A peer-origin near-duplicate arrives later (the real author's skill).
    insertSkillChunk(db, "c-orig", "First Mover Original");
    db.prepare(`UPDATE chunks SET embedding = ?, governance_json = ? WHERE id = 'c-orig'`).run(
      JSON.stringify([1, 0, 0, 0]),
      JSON.stringify({ accessScope: "shared", peerOrigin: "pk-bob" }),
    );
    economics.refreshListings(1.0);
    expect(economics.getListableSkills()).toEqual([]);
    const row = db
      .prepare(
        `SELECT listable, listing_block_reason FROM marketplace_listings WHERE skill_crystal_id = 'c-first'`,
      )
      .get() as { listable: number; listing_block_reason: string };
    expect(row.listable).toBe(0);
    expect(row.listing_block_reason).toContain("lineage");
  });

  it("registry royalty joins by content hash and pays out only to a configured royalty wallet", () => {
    insertSkillChunk(db, "c-reg", "---\nname: whatever\n---\nregistry body");
    const text = (
      db.prepare(`SELECT text FROM chunks WHERE id = 'c-reg'`).get() as { text: string }
    ).text;
    const make = (royaltyWallet?: string) =>
      new MarketplaceEconomics(db, undefined, {
        registryRoyalty: {
          royaltyBps: 1000,
          registryId: "agentskills.io",
          lookup: () =>
            new Map([[`sha256:${contentSha256(text)}`, { registry: "agentskills.io" }]]),
          ...(royaltyWallet ? { royaltyWallet } : {}),
        },
      });
    const shares = make().computeRevenueShares("c-reg", 2.0);
    expect(shares.find((x) => x.role === "registry_royalty")).toEqual({
      role: "registry_royalty",
      peerId: "agentskills.io",
      amountUsdc: 0.2,
    });
    // Accrued, unpaid: no wallet resolves without the operator setting one.
    expect(make().resolvePeerWalletAddress("agentskills.io")).toBeNull();
    expect(make(`0x${"a".repeat(40)}`).resolvePeerWalletAddress("agentskills.io")).toBe(
      `0x${"a".repeat(40)}`,
    );
  });

  it("getSellableSkill serves only for-sale AND listable crystals (no read-by-id primitive)", () => {
    const economics = new MarketplaceEconomics(db);
    insertSkillChunk(db, "c-sell", "Sellable Skill", { forSale: true });
    recordPassingExecutions(db, "c-sell");
    insertSkillChunk(db, "c-free", "Free Skill", { shared: true });
    recordPassingExecutions(db, "c-free");
    economics.refreshListings(1.0);

    const sellable = economics.getSellableSkill("c-sell");
    expect(sellable).toMatchObject({ skillId: "c-sell", name: "Sellable Skill" });
    expect(sellable!.text).toContain("test skill body");

    // A free-propagated crystal has no paid listing: unreachable by id.
    expect(economics.getSellableSkill("c-free")).toBeNull();
    expect(economics.getSellableSkill("no-such-id")).toBeNull();

    // Delisting revokes invocability immediately.
    economics.setForSale("c-sell", false);
    expect(economics.getSellableSkill("c-sell")).toBeNull();
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
