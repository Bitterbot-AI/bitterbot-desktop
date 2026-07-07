import nodeCrypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleForageCheckin,
  handleForageClaim,
  parseHeartbeatTerms,
} from "../gateway/a2a/forage.js";
import { sweepStreamPayouts } from "./bounty-streams.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 Phase 2.1: heartbeat lifecycle — terms parse from spec_public,
// claim opens the stream, check-ins chain + respect cadence, the sweep
// batches payouts and completes the stream when the budget is spent.

const NOW = 1_800_000_000_000;
const HUNTER = "hunter-pk";
const WALLET = "0x2222222222222222222222222222222222222222";
const DAY_MS = 86_400_000;

const SPEC = `Watch https://example.com/pricing daily and report content changes.
{"heartbeat": {"cadenceSeconds": 86400, "perCheckUsdc": 0.05, "alertBonusUsdc": 1}}`;

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
  return db;
}

function insertHeartbeatBounty(db: DatabaseSync, over: Partial<{ reward: number }> = {}) {
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_type, reward_usdc, funding_proof, claim_stake_usdc,
        max_claims, is_local, status, expires_at, created_at, updated_at)
     VALUES ('hb-1', 'poster-pk', '0x1111111111111111111111111111111111111111', 'heartbeat',
             'monitoring', ?, 'sha256:x', 'mechanical', ?, 'attest:s', 0, 1, 1, 'open',
             ?, ?, ?)`,
  ).run(SPEC, over.reward ?? 1, NOW + 365 * DAY_MS, NOW, NOW);
}

function claimStream(db: DatabaseSync): string {
  const out = handleForageClaim(
    { bountyId: "hb-1", hunterPubkey: HUNTER, hunterWallet: WALLET },
    db,
    NOW,
  );
  expect(out.ok).toBe(true);
  return out.ok ? out.result.claimId : "";
}

function checkin(db: DatabaseSync, claimId: string, at: number, hash = `h-${at}`) {
  return handleForageCheckin(
    {
      bountyId: "hb-1",
      claimId,
      hunterPubkey: HUNTER,
      observation: { url: "https://example.com/pricing", contentHash: hash, observedAt: at },
    },
    db,
    at,
  );
}

describe("parseHeartbeatTerms", () => {
  it("parses a valid terms block embedded in prose", () => {
    expect(parseHeartbeatTerms(SPEC)).toEqual({
      cadenceSeconds: 86400,
      perCheckUsdc: 0.05,
      alertBonusUsdc: 1,
    });
  });

  it("rejects missing/invalid terms", () => {
    expect(parseHeartbeatTerms("just prose")).toBeNull();
    expect(
      parseHeartbeatTerms('{"heartbeat": {"cadenceSeconds": 5, "perCheckUsdc": 0.05}}'),
    ).toBeNull();
    expect(parseHeartbeatTerms('{"heartbeat": {"cadenceSeconds": 86400}}')).toBeNull();
  });
});

describe("heartbeat claim + checkin", () => {
  let db: DatabaseSync;
  let claimId: string;
  beforeEach(() => {
    db = openDb();
    insertHeartbeatBounty(db);
    claimId = claimStream(db);
  });

  it("claiming a heartbeat bounty opens an active stream", () => {
    const stream = db.prepare(`SELECT * FROM bounty_streams WHERE id = ?`).get(claimId) as Record<
      string,
      unknown
    >;
    expect(stream.status).toBe("active");
    expect(stream.cadence_seconds).toBe(86400);
    expect(stream.per_check_usdc).toBe(0.05);
  });

  it("check-ins chain observation heads and count up", () => {
    const first = checkin(db, claimId, NOW + DAY_MS);
    expect(first.ok).toBe(true);
    const second = checkin(db, claimId, NOW + 2 * DAY_MS);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.result.checksTotal).toBe(2);
      expect(second.result.observationHead).not.toBe(first.result.observationHead);
    }
  });

  it("rejects check-ins faster than half the cadence and from strangers", () => {
    expect(checkin(db, claimId, NOW + DAY_MS).ok).toBe(true);
    expect(checkin(db, claimId, NOW + DAY_MS + 1000).ok).toBe(false);
    const stranger = handleForageCheckin(
      {
        bountyId: "hb-1",
        claimId,
        hunterPubkey: "snoop",
        observation: { contentHash: "h" },
      },
      db,
      NOW + 3 * DAY_MS,
    );
    expect(stranger.ok).toBe(false);
  });

  it("rejects claiming a heartbeat bounty without a valid terms block", () => {
    db.prepare(
      `UPDATE bounty_posts SET spec_public = 'no terms here' WHERE bounty_id='hb-1'`,
    ).run();
    db.prepare(`DELETE FROM bounty_claims`).run();
    db.prepare(`DELETE FROM bounty_streams`).run();
    const out = handleForageClaim(
      { bountyId: "hb-1", hunterPubkey: "hunter-2", hunterWallet: WALLET },
      db,
      NOW,
    );
    expect(out.ok).toBe(false);
  });
});

describe("sweepStreamPayouts", () => {
  let db: DatabaseSync;
  let claimId: string;
  let queued: Array<{ recipientPeerId: string; amountUsdc: number; role: string }>;
  const economics = () => ({
    queueRevenuePayment: (p: { recipientPeerId: string; amountUsdc: number; role: string }) => {
      queued.push(p);
    },
  });
  beforeEach(() => {
    db = openDb();
    queued = [];
    insertHeartbeatBounty(db); // $1 budget at $0.05/check = 20 checks
    claimId = claimStream(db);
  });

  it("batches unpaid checks into one payment per stream", () => {
    checkin(db, claimId, NOW + DAY_MS);
    checkin(db, claimId, NOW + 2 * DAY_MS);
    checkin(db, claimId, NOW + 3 * DAY_MS);
    const res = sweepStreamPayouts({ db, economics: economics(), now: NOW + 3 * DAY_MS + 1 });
    expect(res.paymentsQueued).toBe(1);
    expect(res.checksPaid).toBe(3);
    expect(queued[0]).toMatchObject({
      recipientPeerId: HUNTER,
      amountUsdc: 0.05 * 3,
      role: "stream_check",
    });
    // Idempotent: nothing unpaid on a second sweep.
    const again = sweepStreamPayouts({ db, economics: economics(), now: NOW + 3 * DAY_MS + 2 });
    expect(again.paymentsQueued).toBe(0);
  });

  it("completes the stream when the budget is spent", () => {
    // 20 checks exhaust the $1 budget exactly.
    for (let i = 1; i <= 20; i++) checkin(db, claimId, NOW + i * DAY_MS);
    const res = sweepStreamPayouts({ db, economics: economics(), now: NOW + 21 * DAY_MS });
    expect(res.checksPaid).toBe(20);
    expect(res.streamsCompleted).toBe(1);
    const stream = db.prepare(`SELECT status FROM bounty_streams WHERE id=?`).get(claimId) as {
      status: string;
    };
    expect(stream.status).toBe("completed");
    const bounty = db.prepare(`SELECT status FROM bounty_posts WHERE bounty_id='hb-1'`).get() as {
      status: string;
    };
    expect(bounty.status).toBe("fulfilled");
    // Post-completion check-ins are refused.
    expect(checkin(db, claimId, NOW + 22 * DAY_MS).ok).toBe(false);
  });

  it("never pays beyond the budget even with excess check-ins", () => {
    for (let i = 1; i <= 25; i++) checkin(db, claimId, NOW + i * DAY_MS);
    // 25 arrive but only 20 are affordable at $0.05 on a $1 budget... the
    // stream completes once affordability hits zero.
    sweepStreamPayouts({ db, economics: economics(), now: NOW + 26 * DAY_MS });
    const paid = queued.reduce((s, q) => s + q.amountUsdc, 0);
    expect(paid).toBeLessThanOrEqual(1.0000001);
  });

  it("ignores streams on non-local bounties", () => {
    checkin(db, claimId, NOW + DAY_MS);
    db.prepare(`UPDATE bounty_posts SET is_local = 0 WHERE bounty_id='hb-1'`).run();
    const res = sweepStreamPayouts({ db, economics: economics(), now: NOW + 2 * DAY_MS });
    expect(res.paymentsQueued).toBe(0);
  });
});

// PLAN-30 G0.3: sealed check-ins. The claim hands the hunter a secret
// nonce; a check-in presenting sealedDigest must satisfy
// sha256(nonce || contentHash). Absence is legacy-accepted; inconsistency
// is rejected (not punished — the verbs are unauthenticated, so a wrong
// seal could be third-party griefing).
describe("sealed check-ins (G0.3)", () => {
  let db: DatabaseSync;
  let claimId: string;
  let nonce: string;

  beforeEach(() => {
    db = openDb();
    insertHeartbeatBounty(db);
    const out = handleForageClaim(
      { bountyId: "hb-1", hunterPubkey: HUNTER, hunterWallet: WALLET },
      db,
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("claim failed");
    claimId = out.result.claimId;
    nonce = out.result.claimNonce;
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  function sealedCheckin(sealedDigest: string | undefined, hash: string, at: number) {
    return handleForageCheckin(
      {
        bountyId: "hb-1",
        claimId,
        hunterPubkey: HUNTER,
        observation: {
          url: "https://example.com/pricing",
          contentHash: hash,
          observedAt: at,
          ...(sealedDigest ? { sealedDigest } : {}),
        },
      },
      db,
      at,
    );
  }

  it("accepts a correctly sealed check-in", () => {
    const hash = "a".repeat(64);
    const seal = nodeCrypto
      .createHash("sha256")
      .update(nonce + hash, "utf-8")
      .digest("hex");
    expect(sealedCheckin(seal, hash, NOW + DAY_MS).ok).toBe(true);
  });

  it("rejects an inconsistent seal", () => {
    const out = sealedCheckin("f".repeat(64), "a".repeat(64), NOW + DAY_MS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toMatch(/sealedDigest/);
    // Nothing was recorded: the stream is untouched.
    const stream = db
      .prepare(`SELECT checks_total FROM bounty_streams WHERE id = ?`)
      .get(claimId) as {
      checks_total: number;
    };
    expect(stream.checks_total).toBe(0);
  });

  it("accepts a legacy check-in with no seal (dual-accept window)", () => {
    expect(sealedCheckin(undefined, "a".repeat(64), NOW + DAY_MS).ok).toBe(true);
  });
});
