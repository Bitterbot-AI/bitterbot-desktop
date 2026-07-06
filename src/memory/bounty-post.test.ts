import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { handleForageClaim } from "../gateway/a2a/forage.js";
import { validatePendingBounties } from "./bounty-funding.js";
import { commitOracleSpec, type OracleSpec } from "./bounty-oracle.js";
import { postForageBounty, type PostBountyInput } from "./bounty-post.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 §4.1: the operator posting path. Mirrors bounty-e2e.test.ts's
// hand-written INSERT — this suite proves postForageBounty() writes the same
// poster-local row (is_local=1, sealed spec) and gossips the matching v2
// envelope, atomically.

const NOW = 1_800_000_000_000;
const WALLET = "0x1111111111111111111111111111111111111111";

const SPEC: OracleSpec = {
  v: 1,
  type: "json",
  salt: "salt-xyz",
  requiredKeys: ["price"],
  minItems: 2,
};

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

function input(overrides: Partial<PostBountyInput> = {}): PostBountyInput {
  return {
    kind: "oneshot",
    category: "extraction",
    specPublic: "Extract at least 2 price rows as JSON",
    oracleSpec: SPEC,
    rewardUsdc: 1,
    expiresAt: NOW + 86_400_000,
    ...overrides,
  };
}

describe("postForageBounty", () => {
  it("writes the poster-local row and publishes the matching v2 envelope", async () => {
    const db = openDb();
    const published: unknown[] = [];
    const result = await postForageBounty({
      db,
      publish: async (b) => {
        published.push(b);
        return { ok: true };
      },
      posterPubkey: WALLET,
      posterPeerId: "12D3KooWTest",
      posterWallet: WALLET,
      input: input(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    const bountyId = result.ok ? result.bountyId : "";

    const row = db
      .prepare(`SELECT * FROM bounty_posts WHERE bounty_id = ?`)
      .get(bountyId) as Record<string, unknown>;
    expect(row.is_local).toBe(1);
    expect(row.status).toBe("unverified");
    expect(row.oracle_spec_private).toBe(JSON.stringify(SPEC));
    expect(row.oracle_commitment).toBe(commitOracleSpec(JSON.stringify(SPEC)));
    expect(row.oracle_type).toBe("mechanical");
    expect(row.poster_pubkey).toBe(WALLET);
    expect(row.poster_peer_id).toBe("12D3KooWTest");
    expect(String(row.funding_proof)).toMatch(/^attest:/);

    expect(published).toHaveLength(1);
    const envelope = published[0] as Record<string, unknown>;
    expect(envelope.version).toBe(2);
    expect(envelope.bounty_id).toBe(bountyId);
    expect(envelope.poster_wallet_address).toBe(WALLET);
    expect(envelope.oracle_commitment).toBe(row.oracle_commitment);
    expect(envelope.reward_usdc).toBe(1);
    // The sealed spec must never leave the node.
    expect(JSON.stringify(envelope)).not.toContain("salt-xyz");
  });

  it("rolls back the local row when the gossip publish fails", async () => {
    const db = openDb();
    const result = await postForageBounty({
      db,
      publish: async () => ({ ok: false, error: "InsufficientPeers" }),
      posterPubkey: WALLET,
      posterWallet: WALLET,
      input: input(),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("InsufficientPeers");
    const count = db.prepare(`SELECT COUNT(*) AS n FROM bounty_posts`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rolls back when publish throws", async () => {
    const db = openDb();
    const result = await postForageBounty({
      db,
      publish: async () => {
        throw new Error("ipc socket closed");
      },
      posterPubkey: WALLET,
      posterWallet: WALLET,
      input: input(),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM bounty_posts`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects invalid inputs before touching db or mesh", async () => {
    const db = openDb();
    const publish = async () => {
      throw new Error("must not be called");
    };
    const base = { db, publish, posterPubkey: WALLET, posterWallet: WALLET, now: NOW };

    const badReward = await postForageBounty({ ...base, input: input({ rewardUsdc: 0 }) });
    expect(badReward.ok).toBe(false);

    const expired = await postForageBounty({ ...base, input: input({ expiresAt: NOW - 1 }) });
    expect(expired.ok).toBe(false);

    const noCategory = await postForageBounty({ ...base, input: input({ category: "  " }) });
    expect(noCategory.ok).toBe(false);

    const count = db.prepare(`SELECT COUNT(*) AS n FROM bounty_posts`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("requires heartbeat terms and posterA2aUrl for heartbeat bounties", async () => {
    const db = openDb();
    const publish = async () => ({ ok: true });
    const base = { db, publish, posterPubkey: WALLET, posterWallet: WALLET, now: NOW };

    const noTerms = await postForageBounty({
      ...base,
      input: input({ kind: "heartbeat", specPublic: "Watch this page daily" }),
    });
    expect(noTerms.ok).toBe(false);
    if (!noTerms.ok) expect(noTerms.error).toContain("heartbeat");

    const noUrl = await postForageBounty({
      ...base,
      input: input({
        kind: "heartbeat",
        specPublic:
          'Watch this page {"heartbeat": {"cadenceSeconds": 86400, "perCheckUsdc": 0.05}}',
      }),
    });
    expect(noUrl.ok).toBe(false);
    if (!noUrl.ok) expect(noUrl.error).toContain("posterA2aUrl");

    const good = await postForageBounty({
      ...base,
      input: input({
        kind: "heartbeat",
        specPublic:
          "Watch this page daily " +
          JSON.stringify({
            heartbeat: { cadenceSeconds: 86_400, perCheckUsdc: 0.05, alertBonusUsdc: 0.5 },
            posterA2aUrl: "https://a2a.example.com/a2a",
            url: "https://example.com/status",
          }),
      }),
    });
    expect(good.ok).toBe(true);
  });

  it("posted bounty clears the standard funding sweep and becomes claimable", async () => {
    const db = openDb();
    const posted = await postForageBounty({
      db,
      publish: async () => ({ ok: true }),
      posterPubkey: WALLET,
      posterWallet: WALLET,
      input: input(),
      now: NOW,
    });
    expect(posted.ok).toBe(true);
    const bountyId = posted.ok ? posted.bountyId : "";

    // Same sweep any stranger's bounty goes through; balance covers reward.
    const sweep = await validatePendingBounties({ db, readBalance: async () => 9, now: NOW });
    expect(sweep.promoted).toBe(1);

    const claim = handleForageClaim(
      {
        bountyId,
        hunterPubkey: "hunter-pk",
        hunterWallet: "0x2222222222222222222222222222222222222222",
      },
      db,
      NOW + 1000,
    );
    expect(claim.ok).toBe(true);
  });

  it("underfunded posts are rejected by the sweep, not fast-pathed", async () => {
    const db = openDb();
    const posted = await postForageBounty({
      db,
      publish: async () => ({ ok: true }),
      posterPubkey: WALLET,
      posterWallet: WALLET,
      input: input({ rewardUsdc: 5 }),
      now: NOW,
    });
    expect(posted.ok).toBe(true);
    const sweep = await validatePendingBounties({ db, readBalance: async () => 1, now: NOW });
    expect(sweep.rejected).toBe(1);
  });
});
