import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Eip3009Authorization } from "./settlement.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { recordPoolPledge, strikeReadyPools } from "./bounty-pools.js";
import { createCaptureExecutor, createCdpEip3009Signer } from "./cdp-adapters.js";

// PLAN-29 Phase 4 (legal-gated): pledges validate structurally against the
// awarded hunter; strike captures ONLY on quorum + oracle pass; below
// quorum nothing is ever captured; per-auth failures never block siblings.
// Adapters: CDP signer produces the spike-verified typed-data shape, and
// the capture executor submits the v,r,s transferWithAuthorization call.

const NOW = 1_800_000_000_000;
const HUNTER_WALLET = "0x2222222222222222222222222222222222222222";

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

function seedPool(db: DatabaseSync, over: Partial<{ status: string; awarded: boolean }> = {}) {
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_type, reward_usdc, claim_stake_usdc, max_claims,
        is_local, status, expires_at, created_at, updated_at)
     VALUES ('pool-1', 'poster-pk', '0x1111111111111111111111111111111111111111', 'pool',
             'research', 'pooled question', 'sha256:x', 'mechanical', 10, 0, 1, 1, ?,
             ?, ?, ?)`,
  ).run(over.status ?? "open", NOW + 86_400_000, NOW, NOW);
  if (over.awarded !== false) {
    db.prepare(
      `INSERT INTO bounty_claims
         (id, bounty_id, hunter_pubkey, hunter_wallet, stake_usdc, status, claimed_at, updated_at)
       VALUES ('c-pool', 'pool-1', 'hunter-pk', ?, 0, 'claimed', ?, ?)`,
    ).run(HUNTER_WALLET, NOW, NOW);
  }
}

function auth(over: Partial<Eip3009Authorization> = {}): Eip3009Authorization {
  return {
    from: over.from ?? "0x4444444444444444444444444444444444444444",
    to: over.to ?? HUNTER_WALLET,
    value: over.value ?? "5000000", // $5
    validAfter: over.validAfter ?? 0,
    validBefore: over.validBefore ?? Math.floor(NOW / 1000) + 86_400,
    nonce: over.nonce ?? "0x" + "ab".repeat(32),
    signature: over.signature ?? "0x" + "11".repeat(64) + "1b",
  };
}

describe("recordPoolPledge", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    seedPool(db);
  });

  it("accepts a valid pledge and reports quorum progress", () => {
    const first = recordPoolPledge(
      db,
      { bountyId: "pool-1", funderPubkey: "f1", auth: auth() },
      NOW,
    );
    expect(first).toMatchObject({ ok: true, pledgedUsdc: 5, quorumUsdc: 10, quorumReached: false });
    const second = recordPoolPledge(
      db,
      {
        bountyId: "pool-1",
        funderPubkey: "f2",
        auth: auth({ from: "0x5555555555555555555555555555555555555555" }),
      },
      NOW,
    );
    expect(second).toMatchObject({ ok: true, pledgedUsdc: 10, quorumReached: true });
  });

  it("rejects pledges to the wrong recipient, duplicates, and expired auths", () => {
    expect(
      recordPoolPledge(
        db,
        {
          bountyId: "pool-1",
          funderPubkey: "f1",
          auth: auth({ to: "0x9999999999999999999999999999999999999999" }),
        },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      recordPoolPledge(db, { bountyId: "pool-1", funderPubkey: "f1", auth: auth() }, NOW).ok,
    ).toBe(true);
    // Same funder wallet again.
    expect(
      recordPoolPledge(db, { bountyId: "pool-1", funderPubkey: "f1", auth: auth() }, NOW).ok,
    ).toBe(false);
    expect(
      recordPoolPledge(
        db,
        {
          bountyId: "pool-1",
          funderPubkey: "f3",
          auth: auth({ from: "0x6666666666666666666666666666666666666666", validBefore: 1 }),
        },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it("rejects pledges before a hunter is awarded", () => {
    const db2 = openDb();
    seedPool(db2, { awarded: false });
    const out = recordPoolPledge(
      db2,
      { bountyId: "pool-1", funderPubkey: "f1", auth: auth() },
      NOW,
    );
    expect(out.ok).toBe(false);
  });
});

describe("strikeReadyPools — confirm-then-capture", () => {
  let db: DatabaseSync;
  let captured: Eip3009Authorization[];
  const executor = (failFor?: string) => ({
    capture: async (a: Eip3009Authorization) => {
      if (failFor && a.from === failFor) throw new Error("authorization cancelled");
      captured.push(a);
      return { txHash: "0xtx" + captured.length };
    },
  });
  const passSettlement = () =>
    db
      .prepare(
        `INSERT INTO bounty_settlements
           (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
            amount_usdc, oracle_verdict, status, created_at)
         VALUES ('s-pool', 'pool-1', 'c-pool', 'poster-pk', 'hunter-pk', ?, 10, 'pass', 'held_review', ?)`,
      )
      .run(HUNTER_WALLET, NOW);

  beforeEach(() => {
    db = openDb();
    captured = [];
    seedPool(db);
  });

  it("captures nothing below quorum even when the oracle passed", async () => {
    recordPoolPledge(db, { bountyId: "pool-1", funderPubkey: "f1", auth: auth() }, NOW); // $5 of $10
    passSettlement();
    const res = await strikeReadyPools({ db, executor: executor(), now: NOW });
    expect(res.belowQuorum).toBe(1);
    expect(captured).toHaveLength(0);
  });

  it("captures nothing without an oracle pass even at quorum", async () => {
    recordPoolPledge(db, { bountyId: "pool-1", funderPubkey: "f1", auth: auth() }, NOW);
    recordPoolPledge(
      db,
      {
        bountyId: "pool-1",
        funderPubkey: "f2",
        auth: auth({ from: "0x5555555555555555555555555555555555555555" }),
      },
      NOW,
    );
    const res = await strikeReadyPools({ db, executor: executor(), now: NOW });
    expect(res.struck).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("strikes at quorum + pass, and a cancelled auth never blocks siblings", async () => {
    recordPoolPledge(db, { bountyId: "pool-1", funderPubkey: "f1", auth: auth() }, NOW);
    recordPoolPledge(
      db,
      {
        bountyId: "pool-1",
        funderPubkey: "f2",
        auth: auth({ from: "0x5555555555555555555555555555555555555555" }),
      },
      NOW,
    );
    passSettlement();
    const res = await strikeReadyPools({
      db,
      executor: executor("0x4444444444444444444444444444444444444444"),
      now: NOW,
    });
    expect(res.struck).toBe(1);
    expect(res.captured).toBe(1);
    expect(res.captureFailed).toBe(1);
    const rows = db
      .prepare(`SELECT funder_wallet, status FROM bounty_pool_auths ORDER BY funder_wallet`)
      .all() as unknown as Array<{ funder_wallet: string; status: string }>;
    expect(rows.map((r) => r.status).toSorted()).toEqual(["capture_failed", "captured"]);
  });
});

describe("forage/fund legal gate", () => {
  it("refuses pool pledges unless pools are explicitly enabled", async () => {
    const { handleForageMethod } = await import("../gateway/a2a/forage.js");
    const db = openDb();
    seedPool(db);
    const params = { bountyId: "pool-1", funderPubkey: "f1", auth: auth() };
    const gated = handleForageMethod("forage/fund", params, db, NOW, {});
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.error.message).toMatch(/not enabled/);
    const open = handleForageMethod("forage/fund", params, db, NOW, { poolsEnabled: true });
    expect(open.ok).toBe(true);
  });
});

describe("cdp adapters", () => {
  it("signer produces the spike-verified typed-data shape per network", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fake = {
      address: "0x4444444444444444444444444444444444444444",
      signTypedData: async (p: Record<string, unknown>) => {
        calls.push(p);
        return "0xsig";
      },
    };
    const signer = createCdpEip3009Signer(fake, "base");
    const out = await signer.signTransfer({
      from: fake.address,
      to: HUNTER_WALLET,
      value: "5000000",
      validAfter: 0,
      validBefore: 9999,
      nonce: "0x" + "ab".repeat(32),
    });
    expect(out.signature).toBe("0xsig");
    const domain = calls[0].domain as Record<string, unknown>;
    expect(domain.name).toBe("USD Coin"); // mainnet; sepolia is "USDC"
    expect(domain.chainId).toBe(8453);
    expect(calls[0].primaryType).toBe("TransferWithAuthorization");

    const sepolia = createCdpEip3009Signer(fake, "base-sepolia");
    await sepolia.signTransfer({
      from: fake.address,
      to: HUNTER_WALLET,
      value: "1",
      validAfter: 0,
      validBefore: 9999,
      nonce: "0x" + "cd".repeat(32),
    });
    const sepoliaDomain = calls[1].domain as Record<string, unknown>;
    expect(sepoliaDomain.name).toBe("USDC");
    expect(sepoliaDomain.chainId).toBe(84532);
  });

  it("capture executor submits transferWithAuthorization calldata to USDC", async () => {
    const sent: Array<{ to: string; data: string }> = [];
    const executor = createCaptureExecutor(
      {
        sendTransaction: async (tx) => {
          sent.push({ to: tx.to, data: tx.data });
          return "0xcapturetx";
        },
      },
      "base",
    );
    const validSig = ("0x" + "11".repeat(32) + "22".repeat(32) + "1b") as string;
    const { txHash } = await executor.capture(auth({ signature: validSig }));
    expect(txHash).toBe("0xcapturetx");
    expect(sent[0].to).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    // transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
    expect(sent[0].data.startsWith("0xe3ee160e")).toBe(true);
  });
});
