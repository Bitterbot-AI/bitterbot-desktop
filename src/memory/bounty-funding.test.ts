import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { validatePendingBounties } from "./bounty-funding.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 Phase 1.1: 'unverified' rows promote to 'open' only when the
// funding proof validates economically; underfunded/malformed proofs reject;
// RPC failures defer (row untouched); expired bounties never open.

const NOW = 1_800_000_000_000;
const WALLET = "0x1111111111111111111111111111111111111111";

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

function insertBounty(
  db: DatabaseSync,
  over: Partial<{
    bounty_id: string;
    reward_usdc: number;
    funding_proof: string | null;
    expires_at: number;
    status: string;
  }> = {},
) {
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_type, reward_usdc, funding_proof, claim_stake_usdc,
        max_claims, is_local, status, expires_at, created_at, updated_at)
     VALUES (?, 'pk', ?, 'oneshot', 'monitoring', 'spec', 'sha256:x', 'mechanical',
             ?, ?, 0, 1, 0, ?, ?, ?, ?)`,
  ).run(
    over.bounty_id ?? "b-1",
    WALLET,
    over.reward_usdc ?? 5,
    over.funding_proof === undefined ? "attest:sig" : over.funding_proof,
    over.status ?? "unverified",
    over.expires_at ?? NOW + 86_400_000,
    NOW - 1000,
    NOW - 1000,
  );
}

function status(db: DatabaseSync, id: string): string {
  return (
    db.prepare(`SELECT status FROM bounty_posts WHERE bounty_id = ?`).get(id) as {
      status: string;
    }
  ).status;
}

function eip3009Proof(over: Partial<{ from: string; value: number; validBefore: number }> = {}) {
  return (
    "eip3009:" +
    Buffer.from(
      JSON.stringify({
        from: over.from ?? WALLET,
        value: over.value ?? 5_000_000,
        validBefore: over.validBefore ?? Math.floor(NOW / 1000) + 86_400,
      }),
    ).toString("base64")
  );
}

describe("validatePendingBounties", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
  });

  it("promotes attest-proofed bounties when balance covers the reward", async () => {
    insertBounty(db);
    const res = await validatePendingBounties({ db, readBalance: async () => 10, now: NOW });
    expect(res.promoted).toBe(1);
    expect(status(db, "b-1")).toBe("open");
  });

  it("rejects attest-proofed bounties when balance is short", async () => {
    insertBounty(db, { reward_usdc: 50 });
    const res = await validatePendingBounties({ db, readBalance: async () => 10, now: NOW });
    expect(res.rejected).toBe(1);
    expect(status(db, "b-1")).toBe("rejected");
  });

  it("defers (leaves unverified) on balance-read failure", async () => {
    insertBounty(db);
    const res = await validatePendingBounties({
      db,
      readBalance: async () => {
        throw new Error("rpc down");
      },
      now: NOW,
    });
    expect(res.deferred).toBe(1);
    expect(status(db, "b-1")).toBe("unverified");
  });

  it("promotes structurally valid eip3009 proofs without a balance read", async () => {
    insertBounty(db, { funding_proof: eip3009Proof() });
    const res = await validatePendingBounties({
      db,
      readBalance: async () => {
        throw new Error("must not be called");
      },
      now: NOW,
    });
    expect(res.promoted).toBe(1);
    expect(status(db, "b-1")).toBe("open");
  });

  it("rejects eip3009 proofs signed by a different wallet, undersized, or expired", async () => {
    insertBounty(db, {
      bounty_id: "wrong-signer",
      funding_proof: eip3009Proof({ from: "0x2222222222222222222222222222222222222222" }),
    });
    insertBounty(db, { bounty_id: "undersized", funding_proof: eip3009Proof({ value: 1 }) });
    insertBounty(db, {
      bounty_id: "auth-expired",
      funding_proof: eip3009Proof({ validBefore: Math.floor(NOW / 1000) - 10 }),
    });
    const res = await validatePendingBounties({ db, readBalance: async () => 999, now: NOW });
    expect(res.rejected).toBe(3);
    expect(status(db, "wrong-signer")).toBe("rejected");
    expect(status(db, "undersized")).toBe("rejected");
    expect(status(db, "auth-expired")).toBe("rejected");
  });

  it("rejects unknown proof schemes and expires stale bounties", async () => {
    insertBounty(db, { bounty_id: "weird", funding_proof: "magic:beans" });
    insertBounty(db, { bounty_id: "stale", expires_at: NOW - 1 });
    const res = await validatePendingBounties({ db, readBalance: async () => 999, now: NOW });
    expect(res.rejected).toBe(1);
    expect(res.expired).toBe(1);
    expect(status(db, "weird")).toBe("rejected");
    expect(status(db, "stale")).toBe("expired");
  });

  it("never touches rows that are not 'unverified'", async () => {
    insertBounty(db, { bounty_id: "already-open", status: "open" });
    insertBounty(db, { bounty_id: "already-rejected", status: "rejected" });
    const res = await validatePendingBounties({ db, readBalance: async () => 0, now: NOW });
    expect(res.promoted + res.rejected + res.expired + res.deferred).toBe(0);
    expect(status(db, "already-open")).toBe("open");
    expect(status(db, "already-rejected")).toBe("rejected");
  });
});

// PLAN-30 G0.4: AGGREGATE solvency — the wallet must cover the new reward
// plus its outstanding open obligations, not each bounty independently.
describe("aggregate solvency (G0.4)", () => {
  it("rejects a bounty the wallet cannot cover on top of open commitments", async () => {
    const db = openDb();
    insertBounty(db, { bounty_id: "b-open", reward_usdc: 5, status: "open" });
    insertBounty(db, { bounty_id: "b-new", reward_usdc: 5 }); // unverified
    // Balance $8: covers either $5 bounty alone, not both.
    const res = await validatePendingBounties({ db, readBalance: async () => 8, now: NOW });
    expect(res.rejected).toBe(1);
    expect(status(db, "b-new")).toBe("rejected");
  });

  it("counts stream spend against commitments (spent money already left the balance)", async () => {
    const db = openDb();
    insertBounty(db, { bounty_id: "b-open", reward_usdc: 5, status: "open" });
    // The open bounty's stream already paid out $4 of its $5.
    db.prepare(
      `INSERT INTO bounty_streams (id, bounty_id, poster_pubkey, hunter_pubkey,
          cadence_seconds, per_check_usdc, alert_bonus_usdc, checks_total, checks_paid,
          audits_total, audits_failed, status, spent_usdc, created_at, updated_at)
       VALUES ('st-1', 'b-open', 'pk', 'h', 86400, 0.05, 0, 80, 80, 0, 0, 'active', 4, ?, ?)`,
    ).run(NOW - 1000, NOW - 1000);
    insertBounty(db, { bounty_id: "b-new", reward_usdc: 5 });
    // Balance $8 >= $1 remaining commitment + $5 new reward.
    const res = await validatePendingBounties({ db, readBalance: async () => 8, now: NOW });
    expect(res.promoted).toBe(1);
    expect(status(db, "b-new")).toBe("open");
  });
});
