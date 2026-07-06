import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { createForageTool } from "./forage-tool.js";

// PLAN-29: the conversational bounty-discovery tool. Execute paths run
// against a real in-memory marketplace db (same schema the gateway uses)
// with getMemorySearchManager mocked to hand it over.

let db: DatabaseSync;

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: async () => ({
    manager: {
      getMarketplaceEconomics: () => ({ getDb: () => db }),
    },
  }),
}));

const minimalConfig: BitterbotConfig = { gateway: { hostId: "test-host" } } as BitterbotConfig;

const NOW = Date.now();

function openDb(): DatabaseSync {
  const fresh = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db: fresh,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(fresh);
  return fresh;
}

function seedBounty(
  target: DatabaseSync,
  opts: { id: string; status?: string; isLocal?: number; expiresAt?: number; reward?: number },
): void {
  target
    .prepare(
      `INSERT INTO bounty_posts
         (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
          oracle_commitment, oracle_type, reward_usdc, funding_proof,
          claim_stake_usdc, max_claims, is_local, status, expires_at,
          created_at, updated_at)
       VALUES (?, 'poster-pk', '0x1111111111111111111111111111111111111111',
               'heartbeat', 'monitoring',
               'Watch the page daily {"heartbeat": {"cadenceSeconds": 86400, "perCheckUsdc": 0.05}}',
               'sha256:abc', 'mechanical', ?, 'attest:x', 0, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.reward ?? 1,
      opts.isLocal ?? 0,
      opts.status ?? "open",
      opts.expiresAt ?? NOW + 86_400_000,
      NOW,
      NOW,
    );
}

function readPayload(result: { details?: unknown }): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  db = openDb();
});

describe("createForageTool", () => {
  it("returns null when no config is provided", () => {
    expect(createForageTool({})).toBeNull();
  });

  it("registers under name=forage and maps the 'forge' mishearing", () => {
    const tool = createForageTool({ config: minimalConfig });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("forage");
    const desc = (tool?.description ?? "").toLowerCase();
    expect(desc).toContain("bounty");
    expect(desc).toContain("forge");
    for (const action of ["list", "stats", "mine", "hunts"]) {
      expect(desc).toContain(action);
    }
  });

  it("list returns open, unexpired bounties and excludes unverified/expired", async () => {
    seedBounty(db, { id: "open-1" });
    seedBounty(db, { id: "unverified-1", status: "unverified" });
    seedBounty(db, { id: "expired-1", expiresAt: NOW - 1000 });
    const tool = createForageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const payload = readPayload(await tool.execute("t", { action: "list" }));
    expect(payload.available).toBe(true);
    expect(payload.openBounties).toBe(1);
    const bounties = payload.bounties as Array<Record<string, unknown>>;
    expect(bounties[0].bountyId).toBe("open-1");
    // Machine block stripped from the excerpt.
    expect(String(bounties[0].spec)).not.toContain("cadenceSeconds");
  });

  it("mine returns only locally-posted bounties with claim counts", async () => {
    seedBounty(db, { id: "mine-1", isLocal: 1 });
    seedBounty(db, { id: "theirs-1", isLocal: 0 });
    db.prepare(
      `INSERT INTO bounty_claims (id, bounty_id, hunter_pubkey, hunter_wallet,
         stake_usdc, status, claimed_at, updated_at)
       VALUES ('c1', 'mine-1', 'hunter-pk', '0x2222222222222222222222222222222222222222',
               0, 'claimed', ?, ?)`,
    ).run(NOW, NOW);
    const tool = createForageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const payload = readPayload(await tool.execute("t", { action: "mine" }));
    const posted = payload.posted as Array<Record<string, unknown>>;
    expect(posted).toHaveLength(1);
    expect(posted[0].bountyId).toBe("mine-1");
    expect(posted[0].claims).toBe(1);
  });

  it("hunts reports Night Shift totals", async () => {
    db.prepare(
      `INSERT INTO forage_hunts (claim_id, bounty_id, poster_pubkey, poster_a2a_url,
         category, kind, reward_usdc, status, checks_sent, earned_usdc, claimed_at, updated_at)
       VALUES ('h1', 'b1', 'poster-pk', 'https://x/a2a', 'monitoring', 'heartbeat',
               1, 'claimed', 3, 0.15, ?, ?)`,
    ).run(NOW, NOW);
    const tool = createForageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const payload = readPayload(await tool.execute("t", { action: "hunts" }));
    expect(payload.totalEarnedUsdc).toBeCloseTo(0.15);
    expect(payload.totalHunts).toBe(1);
    const hunts = payload.hunts as Array<Record<string, unknown>>;
    expect(hunts[0].checksSent).toBe(3);
  });

  it("stats returns the scoreboard shape", async () => {
    seedBounty(db, { id: "open-1" });
    const tool = createForageTool({ config: minimalConfig });
    if (!tool) throw new Error("tool missing");
    const payload = readPayload(await tool.execute("t", { action: "stats" }));
    expect(payload.available).toBe(true);
    expect(payload.openBounties).toBe(1);
    expect(payload).toHaveProperty("dpsv7d");
  });
});
