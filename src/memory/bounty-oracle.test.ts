import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitOracleSpec,
  parseBountyJudgeReply,
  runMechanicalOracle,
  settleDeliveredClaims,
  type OracleSpec,
} from "./bounty-oracle.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 Phase 1.3: sealed-spec verification, mechanical oracles, the
// judge cap, and the full settle path (settlement row + payout queue +
// claim/bounty status transitions).

const NOW = 1_800_000_000_000;
const HUNTER = "hunter-pk";
const WALLET = "0x2222222222222222222222222222222222222222";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  // Runtime DDL owned by PeerReputationManager / MarketplaceEconomics in
  // production (not the migration chain) — mirrored here.
  db.exec(`ALTER TABLE peer_reputation ADD COLUMN wallet_address TEXT`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_payment_queue (
      id TEXT PRIMARY KEY,
      skill_crystal_id TEXT NOT NULL,
      purchase_id TEXT NOT NULL,
      recipient_peer_id TEXT NOT NULL,
      amount_usdc REAL NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      release_at INTEGER NOT NULL
    )
  `);
  return db;
}

function seed(
  db: DatabaseSync,
  spec: OracleSpec,
  content: string,
  over: Partial<{ reward: number; tamperCommitment: boolean }> = {},
) {
  const specJson = JSON.stringify(spec);
  const commitment = over.tamperCommitment ? "sha256:deadbeef" : commitOracleSpec(specJson);
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_spec_private, oracle_type, reward_usdc, funding_proof,
        claim_stake_usdc, max_claims, is_local, status, expires_at, created_at, updated_at)
     VALUES ('b-1', 'poster-pk', '0x1111111111111111111111111111111111111111', 'oneshot',
             'extraction', 'spec', ?, ?, 'mechanical', ?, 'attest:s', 0, 1, 1, 'open',
             ?, ?, ?)`,
  ).run(commitment, specJson, over.reward ?? 5, NOW + 86_400_000, NOW - 5000, NOW - 5000);
  db.prepare(
    `INSERT INTO bounty_claims
       (id, bounty_id, hunter_pubkey, hunter_wallet, stake_usdc, status,
        deliverable_ref, claimed_at, delivered_at, updated_at)
     VALUES ('c-1', 'b-1', ?, ?, 0, 'delivered', ?, ?, ?, ?)`,
  ).run(
    HUNTER,
    WALLET,
    JSON.stringify({
      sha256: "x",
      contentB64: Buffer.from(content, "utf-8").toString("base64"),
    }),
    NOW - 4000,
    NOW - 1000,
    NOW - 1000,
  );
}

function claimStatus(db: DatabaseSync): string {
  return (
    db.prepare(`SELECT status FROM bounty_claims WHERE id='c-1'`).get() as {
      status: string;
    }
  ).status;
}

function queuedPayments(db: DatabaseSync) {
  return db
    .prepare(`SELECT recipient_peer_id, amount_usdc, role, status FROM revenue_payment_queue`)
    .all() as unknown as Array<Record<string, unknown>>;
}

describe("mechanical oracles", () => {
  it("json: required keys + minItems", () => {
    const spec: OracleSpec = { v: 1, type: "json", salt: "s", requiredKeys: ["name"], minItems: 2 };
    expect(runMechanicalOracle(spec, '[{"name":"a"},{"name":"b"}]').verdict).toBe("pass");
    expect(runMechanicalOracle(spec, '[{"name":"a"}]').verdict).toBe("fail");
    expect(runMechanicalOracle(spec, '[{"nope":1},{"nope":2}]').verdict).toBe("fail");
    expect(runMechanicalOracle(spec, "not json").verdict).toBe("fail");
  });

  it("contains: all/any/none", () => {
    const spec: OracleSpec = {
      v: 1,
      type: "contains",
      salt: "s",
      all: ["alpha"],
      any: ["beta", "gamma"],
      none: ["banned"],
    };
    expect(runMechanicalOracle(spec, "alpha and gamma").verdict).toBe("pass");
    expect(runMechanicalOracle(spec, "gamma only").verdict).toBe("fail");
    expect(runMechanicalOracle(spec, "alpha only").verdict).toBe("fail");
    expect(runMechanicalOracle(spec, "alpha beta banned").verdict).toBe("fail");
  });

  it("regex passes and fails closed on bad patterns", () => {
    expect(
      runMechanicalOracle({ v: 1, type: "regex", salt: "s", pattern: "^\\d+$" }, "12345").verdict,
    ).toBe("pass");
    expect(
      runMechanicalOracle({ v: 1, type: "regex", salt: "s", pattern: "([" }, "x").verdict,
    ).toBe("fail");
  });
});

describe("judge reply parsing fails closed", () => {
  it("only an unambiguous pass is a pass", () => {
    expect(parseBountyJudgeReply("VERDICT: pass")).toBe("pass");
    expect(parseBountyJudgeReply("verdict: PASS")).toBe("pass");
    expect(parseBountyJudgeReply("VERDICT: fail")).toBe("fail");
    expect(parseBountyJudgeReply("I think it passes")).toBe("fail");
    expect(parseBountyJudgeReply("")).toBe("fail");
  });
});

describe("settleDeliveredClaims", () => {
  let db: DatabaseSync;
  let queued: Array<{ recipientPeerId: string; amountUsdc: number; role: string }>;
  const economics = () => ({
    queueRevenuePayment: (p: { recipientPeerId: string; amountUsdc: number; role: string }) => {
      queued.push(p);
      db.prepare(
        `INSERT INTO revenue_payment_queue
           (id, skill_crystal_id, purchase_id, recipient_peer_id, amount_usdc, role,
            status, queued_at, release_at)
         VALUES (?, 'bounty:b-1', 'p', ?, ?, ?, 'held', ?, ?)`,
      ).run(String(queued.length), p.recipientPeerId, p.amountUsdc, p.role, NOW, NOW + 1);
    },
  });
  beforeEach(() => {
    db = openDb();
    queued = [];
  });

  it("settles a passing mechanical oracle end to end", async () => {
    seed(db, { v: 1, type: "contains", salt: "s", all: ["result"] }, "the result is 42");
    const res = await settleDeliveredClaims({ db, economics: economics(), now: NOW });
    expect(res.settled).toBe(1);
    expect(claimStatus(db)).toBe("verified");
    expect(queued).toEqual([
      {
        skillCrystalId: "bounty:b-1",
        purchaseId: expect.any(String),
        recipientPeerId: HUNTER,
        amountUsdc: 5,
        role: "bounty_reward",
      },
    ]);
    const settlement = db
      .prepare(`SELECT oracle_verdict, status FROM bounty_settlements WHERE claim_id='c-1'`)
      .get() as { oracle_verdict: string; status: string };
    expect(settlement.oracle_verdict).toBe("pass");
    const bounty = db.prepare(`SELECT status FROM bounty_posts WHERE bounty_id='b-1'`).get() as {
      status: string;
    };
    expect(bounty.status).toBe("fulfilled");
    const rep = db
      .prepare(`SELECT wallet_address FROM peer_reputation WHERE peer_pubkey=?`)
      .get(HUNTER) as { wallet_address: string };
    expect(rep.wallet_address).toBe(WALLET);
  });

  it("fails the claim on a failing oracle and queues nothing", async () => {
    seed(db, { v: 1, type: "contains", salt: "s", all: ["missing-term"] }, "wrong content");
    const res = await settleDeliveredClaims({ db, economics: economics(), now: NOW });
    expect(res.failed).toBe(1);
    expect(claimStatus(db)).toBe("failed");
    expect(queuedPayments(db)).toHaveLength(0);
  });

  it("refuses to settle when the stored spec does not match the commitment", async () => {
    seed(db, { v: 1, type: "contains", salt: "s", all: ["result"] }, "the result", {
      tamperCommitment: true,
    });
    const res = await settleDeliveredClaims({ db, economics: economics(), now: NOW });
    expect(res.commitmentMismatches).toBe(1);
    expect(claimStatus(db)).toBe("delivered"); // untouched
    expect(queuedPayments(db)).toHaveLength(0);
  });

  it("judge pass within the cap pays; above the cap parks at held_review", async () => {
    seed(db, { v: 1, type: "judge", salt: "s", criteria: "mentions 42" }, "it is 42");
    const passJudge = async () => "VERDICT: pass";
    let res = await settleDeliveredClaims({
      db,
      economics: economics(),
      judgeLlm: passJudge,
      now: NOW,
    });
    expect(res.settled).toBe(1);
    expect(queued).toHaveLength(1);

    // Fresh db: same judge, reward above the unilateral cap.
    db = openDb();
    queued = [];
    seed(db, { v: 1, type: "judge", salt: "s", criteria: "mentions 42" }, "it is 42", {
      reward: 50,
    });
    res = await settleDeliveredClaims({
      db,
      economics: economics(),
      judgeLlm: passJudge,
      now: NOW,
    });
    expect(res.heldForReview).toBe(1);
    expect(queued).toHaveLength(0);
    const settlement = db
      .prepare(`SELECT status, judge_capped FROM bounty_settlements WHERE claim_id='c-1'`)
      .get() as { status: string; judge_capped: number };
    expect(settlement.status).toBe("held_review");
    expect(settlement.judge_capped).toBe(1);
  });

  it("defers judge oracles when no judge LLM is registered", async () => {
    seed(db, { v: 1, type: "judge", salt: "s", criteria: "x" }, "content");
    const res = await settleDeliveredClaims({
      db,
      economics: economics(),
      judgeLlm: null,
      now: NOW,
    });
    expect(res.deferred).toBe(1);
    expect(claimStatus(db)).toBe("delivered");
  });

  it("ignores delivered claims on non-local bounties", async () => {
    seed(db, { v: 1, type: "contains", salt: "s", all: ["result"] }, "the result");
    db.prepare(`UPDATE bounty_posts SET is_local = 0 WHERE bounty_id='b-1'`).run();
    const res = await settleDeliveredClaims({ db, economics: economics(), now: NOW });
    expect(res.settled + res.failed).toBe(0);
    expect(claimStatus(db)).toBe("delivered");
  });
});
