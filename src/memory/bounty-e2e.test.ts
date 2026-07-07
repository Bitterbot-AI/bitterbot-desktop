import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  handleForageClaim,
  handleForageDeliver,
  handleForageVerdict,
} from "../gateway/a2a/forage.js";
import { validatePendingBounties } from "./bounty-funding.js";
import { commitOracleSpec, settleDeliveredClaims, type OracleSpec } from "./bounty-oracle.js";
import { computeDpsv, computeTrustTier } from "./bounty-reputation.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 Phase 1.4: the full poster-side loop in one test —
// post (unverified) -> funding validation (open) -> claim -> deliver ->
// oracle pass -> settlement + payout queued -> verdict poll -> DPSV/tier.
// This is the wiring proof that every Phase 0/1 piece composes.

const NOW = 1_800_000_000_000;
const HUNTER = "hunter-pk";
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
  db.exec(`ALTER TABLE peer_reputation ADD COLUMN wallet_address TEXT`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_payment_queue (
      id TEXT PRIMARY KEY, skill_crystal_id TEXT NOT NULL, purchase_id TEXT NOT NULL,
      recipient_peer_id TEXT NOT NULL, amount_usdc REAL NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL, queued_at INTEGER NOT NULL, release_at INTEGER NOT NULL
    )
  `);
  return db;
}

it("post -> fund -> claim -> deliver -> verify -> queue payout, end to end", async () => {
  const db = openDb();

  // 1. POST: local bounty lands as 'unverified' with a sealed oracle spec.
  const spec: OracleSpec = {
    v: 1,
    type: "json",
    salt: "salt-123",
    requiredKeys: ["price"],
    minItems: 2,
  };
  const specJson = JSON.stringify(spec);
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_spec_private, oracle_type, reward_usdc, funding_proof,
        claim_stake_usdc, max_claims, is_local, status, expires_at, created_at, updated_at)
     VALUES ('bounty-e2e', 'poster-pk', '0x1111111111111111111111111111111111111111',
             'oneshot', 'extraction', 'Extract at least 2 price rows as JSON',
             ?, ?, 'mechanical', 1, 'attest:sig', 0, 1, 1, 'unverified',
             ?, ?, ?)`,
  ).run(commitOracleSpec(specJson), specJson, NOW + 86_400_000, NOW, NOW);

  // 2. FUND: balance covers the reward -> 'open'.
  const funding = await validatePendingBounties({ db, readBalance: async () => 50, now: NOW });
  expect(funding.promoted).toBe(1);

  // 3. CLAIM: T0 hunter claims a $1 bounty (within the apprentice cap).
  expect(computeTrustTier(db, HUNTER)).toBe(0);
  const claim = handleForageClaim(
    { bountyId: "bounty-e2e", hunterPubkey: HUNTER, hunterWallet: HUNTER_WALLET },
    db,
    NOW + 1000,
  );
  expect(claim.ok).toBe(true);
  const claimId = claim.ok ? claim.result.claimId : "";

  // 4. DELIVER: schema-satisfying JSON.
  const deliver = handleForageDeliver(
    {
      bountyId: "bounty-e2e",
      claimId,
      hunterPubkey: HUNTER,
      content: '[{"price": 9.99}, {"price": 19.99}]',
    },
    db,
    NOW + 2000,
  );
  expect(deliver.ok).toBe(true);

  // 5. VERIFY + SETTLE: oracle passes, settlement written, payout queued.
  const queued: Array<{ recipientPeerId: string; amountUsdc: number; role: string }> = [];
  const sweep = await settleDeliveredClaims({
    db,
    economics: {
      queueRevenuePayment: (p) => {
        queued.push(p);
        db.prepare(
          `INSERT INTO revenue_payment_queue
             (id, skill_crystal_id, purchase_id, recipient_peer_id, amount_usdc, role,
              status, queued_at, release_at)
           VALUES ('q-1', ?, ?, ?, ?, ?, 'held', ?, ?)`,
        ).run(p.skillCrystalId, p.purchaseId, p.recipientPeerId, p.amountUsdc, p.role, NOW, NOW);
      },
    },
    now: NOW + 3000,
  });
  expect(sweep.settled).toBe(1);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    recipientPeerId: HUNTER,
    amountUsdc: 1,
    role: "bounty_reward",
  });

  // 6. VERDICT POLL: the hunter sees pass + queued settlement.
  const verdict = handleForageVerdict(
    { bountyId: "bounty-e2e", claimId, hunterPubkey: HUNTER },
    db,
  );
  expect(verdict.ok).toBe(true);
  if (verdict.ok) {
    expect(verdict.result.claimStatus).toBe("verified");
    expect(verdict.result.verdict).toBe("pass");
    expect(verdict.result.settlementStatus).toBe("queued");
  }

  // 7. LEDGER TRUTH: wallet recorded for dispatch, DPSV counts the queued
  // settlement — but the tier does NOT climb yet. PLAN-30 G0.2 closed the
  // apprenticeship leak: a pre-payment 'queued' row no longer promotes T0
  // hunters; promotion waits for dispatched money ('paid') or a cleared
  // audit apprenticeship (CV >= 10).
  const rep = db
    .prepare(`SELECT wallet_address FROM peer_reputation WHERE peer_pubkey = ?`)
    .get(HUNTER) as { wallet_address: string };
  expect(rep.wallet_address).toBe(HUNTER_WALLET);
  expect(computeTrustTier(db, HUNTER)).toBe(0);
  const dpsv = computeDpsv(db);
  expect(dpsv.totalUsd).toBe(1);
  expect(dpsv.selfLoopExcludedUsd).toBe(0);

  // 8. PAYMENT DISPATCH: once the settlement is paid, the tier climbs.
  db.prepare(`UPDATE bounty_settlements SET status = 'paid' WHERE claim_id = ?`).run(claimId);
  expect(computeTrustTier(db, HUNTER)).toBe(1);
});
