import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { handleForageCheckin, handleForageClaim } from "../gateway/a2a/forage.js";
import {
  APPRENTICESHIP_CV,
  AUDIT_FLOOR_RATE,
  auditCheckinIfDue,
  auditProbability,
  contentDigest,
  forfeitHunter,
  getHunterAuditState,
  normalizeContent,
  recordAuditOutcome,
  simhash64,
  simhashDistance,
} from "./bounty-audit.js";
import { computeTrustTier } from "./bounty-reputation.js";
import { MarketplaceEconomics } from "./marketplace-economics.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-30 G0.1/G0.2: per-check observation log, adaptive audits with
// two-tier verdicts, CV state, and forfeiture. Deterrence contract under
// test: pass increments CV, failed resets it, unverifiable never punishes,
// fraud seizes held bounty earnings and voids queued settlements.

const NOW = 1_800_000_000_000;
const HUNTER = "hunter-pk";
const WALLET = "0x2222222222222222222222222222222222222222";
const DAY_MS = 86_400_000;
const MONITOR_URL = "https://example.com/pricing";

const SPEC = `Watch ${MONITOR_URL} daily and report content changes.
{"heartbeat": {"cadenceSeconds": 86400, "perCheckUsdc": 0.05, "alertBonusUsdc": 1},
 "url": "${MONITOR_URL}", "posterA2aUrl": "https://poster.example/a2a"}`;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  // The revenue rail's tables live in MarketplaceEconomics' ensure-schema,
  // same db handle as the bounty tables in production.
  new MarketplaceEconomics(db);
  return db;
}

function insertHeartbeatBounty(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_type, reward_usdc, funding_proof, claim_stake_usdc,
        max_claims, is_local, status, expires_at, created_at, updated_at)
     VALUES ('hb-1', 'poster-pk', '0x1111111111111111111111111111111111111111', 'heartbeat',
             'monitoring', ?, 'sha256:x', 'mechanical', 1, 'attest:s', 0, 1, 1, 'open',
             ?, ?, ?)`,
  ).run(SPEC, NOW + 365 * DAY_MS, NOW, NOW);
}

function claimStream(db: DatabaseSync): string {
  const out = handleForageClaim(
    { bountyId: "hb-1", hunterPubkey: HUNTER, hunterWallet: WALLET },
    db,
    NOW,
  );
  if (!out.ok) throw new Error(out.error.message);
  return out.result.claimId;
}

function checkin(db: DatabaseSync, claimId: string, body: string, at: number) {
  return handleForageCheckin(
    {
      bountyId: "hb-1",
      claimId,
      hunterPubkey: HUNTER,
      observation: {
        url: MONITOR_URL,
        contentHash: contentDigest(body, "norm-v1"),
        digestScheme: "norm-v1",
        simhash: simhash64(body),
        observedAt: at,
      },
    },
    db,
    at,
  );
}

function fakeFetch(
  bodies: string[] | { error: true },
): Parameters<typeof auditCheckinIfDue>[0]["fetchImpl"] {
  let i = 0;
  return async () => {
    if ("error" in (bodies as { error?: true }) && (bodies as { error?: true }).error) {
      throw new Error("ECONNREFUSED");
    }
    const list = bodies as string[];
    const body = list[Math.min(i, list.length - 1)];
    i++;
    return { ok: true, status: 200, text: async () => body };
  };
}

describe("normalization + simhash", () => {
  it("strips scripts, comments, and asset cache-busters", () => {
    const a = `<html><script>let t=1111</script><!-- ts:9 --><img src="/x.png?v=1"> Hello  world</html>`;
    const b = `<html><script>let t=2222</script><!-- ts:8 --><img src="/x.png?v=2"> Hello world</html>`;
    expect(normalizeContent(a)).toBe(normalizeContent(b));
    expect(contentDigest(a, "norm-v1")).toBe(contentDigest(b, "norm-v1"));
  });

  it("near-identical pages land within simhash tolerance, different pages do not", () => {
    const base = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const drifted = `${base} trailing footnote`;
    const different = Array.from({ length: 200 }, (_, i) => `other${i}`).join(" ");
    expect(simhashDistance(simhash64(base), simhash64(drifted))).toBeLessThanOrEqual(6);
    expect(simhashDistance(simhash64(base), simhash64(different))).toBeGreaterThan(6);
  });
});

describe("audit probability schedule", () => {
  it("audits everything during the apprenticeship, then decays to the floor", () => {
    expect(auditProbability(0)).toBe(1);
    expect(auditProbability(APPRENTICESHIP_CV - 1)).toBe(1);
    expect(auditProbability(APPRENTICESHIP_CV)).toBeCloseTo(1 / APPRENTICESHIP_CV);
    expect(auditProbability(1000)).toBe(AUDIT_FLOOR_RATE);
  });
});

describe("checkin writes the per-check observation log", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    insertHeartbeatBounty(db);
  });

  it("stores digest, scheme, simhash, and chain heads per check", () => {
    const claimId = claimStream(db);
    const r1 = checkin(db, claimId, "<p>day one</p>", NOW + DAY_MS);
    expect(r1.ok).toBe(true);
    const r2 = checkin(db, claimId, "<p>day two</p>", NOW + 2 * DAY_MS);
    expect(r2.ok).toBe(true);

    const rows = db
      .prepare(`SELECT * FROM bounty_stream_checks WHERE stream_id = ? ORDER BY seq`)
      .all(claimId) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(1);
    expect(rows[0].prev_head).toBe("genesis");
    expect(rows[0].digest_scheme).toBe("norm-v1");
    expect(rows[0].audit_status).toBe("unaudited");
    expect(rows[1].seq).toBe(2);
    expect(rows[1].prev_head).toBe(rows[0].head);
    // Chain integrity: head_n = sha256(head_{n-1} || contentHash_n)
    const expectedHead = crypto
      .createHash("sha256")
      .update(String(rows[1].prev_head) + String(rows[1].content_digest), "utf-8")
      .digest("hex");
    expect(rows[1].head).toBe(expectedHead);
  });
});

describe("auditCheckinIfDue verdicts", () => {
  let db: DatabaseSync;
  let claimId: string;
  // Realistic-length page: simhash tolerance is proportional, so tiny drift
  // on a tiny document reads as a rewrite. ~200 words matches real pages.
  const BODY = `<html><h1>Pricing</h1><p>${Array.from(
    { length: 200 },
    (_, i) => `plan feature ${i} detail`,
  ).join(" ")}</p></html>`;

  beforeEach(() => {
    db = openDb();
    insertHeartbeatBounty(db);
    claimId = claimStream(db);
  });

  it("passes when the auditor reproduces the digest, and increments CV", async () => {
    checkin(db, claimId, BODY, NOW + DAY_MS);
    const out = await auditCheckinIfDue({
      db,
      streamId: claimId,
      fetchImpl: fakeFetch([BODY]),
      now: NOW + DAY_MS + 1000,
      roll: 0, // force the audit
    });
    expect(out).toMatchObject({ audited: true, verdict: "pass" });
    expect(getHunterAuditState(db, HUNTER).cv).toBe(1);
    const row = db
      .prepare(`SELECT audit_status FROM bounty_stream_checks WHERE stream_id = ? AND seq = 1`)
      .get(claimId) as { audit_status: string };
    expect(row.audit_status).toBe("pass");
  });

  it("passes via simhash tolerance when content drifted slightly", async () => {
    checkin(db, claimId, BODY, NOW + DAY_MS);
    const drifted = BODY.replace("</html>", "<footer>tiny new footer</footer></html>");
    const out = await auditCheckinIfDue({
      db,
      streamId: claimId,
      fetchImpl: fakeFetch([drifted, drifted]),
      now: NOW + DAY_MS + 1000,
      roll: 0,
    });
    expect(out).toMatchObject({ audited: true, verdict: "pass" });
  });

  it("is unverifiable when the auditor's own fetches disagree — CV unchanged", async () => {
    checkin(db, claimId, BODY, NOW + DAY_MS);
    recordAuditOutcome(db, HUNTER, "pass", NOW); // pre-existing cv=1
    const out = await auditCheckinIfDue({
      db,
      streamId: claimId,
      fetchImpl: fakeFetch(["<p>version A</p>", "<p>version B</p>"]),
      now: NOW + DAY_MS + 1000,
      roll: 0,
    });
    expect(out).toMatchObject({ audited: true, verdict: "unverifiable" });
    expect(getHunterAuditState(db, HUNTER).cv).toBe(1);
  });

  it("fails (CV reset, nothing seized) when stable content contradicts the claim", async () => {
    checkin(db, claimId, BODY, NOW + DAY_MS);
    recordAuditOutcome(db, HUNTER, "pass", NOW);
    recordAuditOutcome(db, HUNTER, "pass", NOW);
    const totallyDifferent =
      "<html><h1>Completely different page about sailing boats and weather</h1></html>";
    const out = await auditCheckinIfDue({
      db,
      streamId: claimId,
      fetchImpl: fakeFetch([totallyDifferent, totallyDifferent]),
      now: NOW + DAY_MS + 1000,
      roll: 0,
    });
    expect(out).toMatchObject({ audited: true, verdict: "failed" });
    expect(getHunterAuditState(db, HUNTER).cv).toBe(0);
    const stream = db
      .prepare(`SELECT audits_total, audits_failed FROM bounty_streams WHERE id = ?`)
      .get(claimId) as { audits_total: number; audits_failed: number };
    expect(stream.audits_total).toBe(1);
    expect(stream.audits_failed).toBe(1);
  });

  it("skips the audit when the dice roll exceeds the probability", async () => {
    // Push hunter past apprenticeship so p = 1/cv < 1.
    for (let i = 0; i < 20; i++) recordAuditOutcome(db, HUNTER, "pass", NOW);
    checkin(db, claimId, BODY, NOW + DAY_MS);
    const out = await auditCheckinIfDue({
      db,
      streamId: claimId,
      fetchImpl: fakeFetch([BODY]),
      now: NOW + DAY_MS + 1000,
      roll: 0.99,
    });
    expect(out.audited).toBe(false);
  });
});

describe("forfeiture (G0.2)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    insertHeartbeatBounty(db);
  });

  function queuePayment(role: string, amount: number, status = "held"): void {
    db.prepare(
      `INSERT INTO revenue_payment_queue
         (id, skill_crystal_id, purchase_id, recipient_peer_id, amount_usdc, role,
          status, queued_at, release_at)
       VALUES (?, 'bounty:hb-1', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), crypto.randomUUID(), HUNTER, amount, role, status, NOW, NOW);
  }

  function queueSettlement(status = "queued"): void {
    db.prepare(
      `INSERT INTO bounty_settlements
         (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
          amount_usdc, oracle_verdict, judge_capped, status, created_at)
       VALUES (?, 'hb-1', ?, 'poster-pk', ?, ?, 0.5, 'pass', 0, ?, ?)`,
    ).run(crypto.randomUUID(), crypto.randomUUID(), HUNTER, WALLET, status, NOW);
  }

  it("seizes held bounty payments and voids queued settlements, resets CV", () => {
    for (let i = 0; i < 12; i++) recordAuditOutcome(db, HUNTER, "pass", NOW);
    queuePayment("stream_check", 0.25);
    queuePayment("bounty_reward", 0.5);
    queuePayment("skill_revenue", 1.0); // non-bounty: untouched
    queuePayment("stream_check", 0.1, "paid"); // already dispatched: untouched
    queueSettlement("queued");
    queueSettlement("paid");

    const result = forfeitHunter(db, HUNTER, "sealed digest inconsistent", NOW);
    expect(result.heldPaymentsForfeited).toBe(2);
    expect(result.heldUsdForfeited).toBeCloseTo(0.75);
    expect(result.settlementsForfeited).toBe(1);
    expect(getHunterAuditState(db, HUNTER).cv).toBe(0);
    expect(getHunterAuditState(db, HUNTER).frauds).toBe(1);

    const rows = db
      .prepare(
        `SELECT role, status FROM revenue_payment_queue WHERE recipient_peer_id = ? ORDER BY role`,
      )
      .all(HUNTER) as unknown as Array<{ role: string; status: string }>;
    expect(rows.find((r) => r.role === "skill_revenue")?.status).toBe("held");
    expect(rows.filter((r) => r.status === "forfeited")).toHaveLength(2);
  });

  it("forfeited settlements no longer count toward trust tier", () => {
    for (let i = 0; i < 12; i++) recordAuditOutcome(db, HUNTER, "pass", NOW);
    queueSettlement("queued");
    expect(computeTrustTier(db, HUNTER)).toBe(1);
    forfeitHunter(db, HUNTER, "test", NOW);
    expect(computeTrustTier(db, HUNTER)).toBe(0);
  });
});

describe("CV-gated release of stream earnings (G0.2)", () => {
  it("stream_check payments stay held until CV >= 10; other roles release on age", () => {
    const db = openDb();
    const economics = new MarketplaceEconomics(db);
    economics.queueRevenuePayment({
      skillCrystalId: "bounty:hb-1",
      purchaseId: "p1",
      recipientPeerId: HUNTER,
      amountUsdc: 0.25,
      role: "stream_check",
    });
    economics.queueRevenuePayment({
      skillCrystalId: "skill-1",
      purchaseId: "p2",
      recipientPeerId: HUNTER,
      amountUsdc: 1,
      role: "seller",
    });
    // Age both rows past the 48h hold.
    db.prepare(`UPDATE revenue_payment_queue SET release_at = ?`).run(Date.now() - 1000);

    // Apprentice hunter (cv < 10): only the non-bounty payment releases.
    expect(economics.releaseHeldPayments()).toBe(1);
    const held = db
      .prepare(`SELECT role FROM revenue_payment_queue WHERE status = 'held'`)
      .all() as unknown as Array<{ role: string }>;
    expect(held).toEqual([{ role: "stream_check" }]);

    // Clearing the apprenticeship releases the stream earnings.
    for (let i = 0; i < 10; i++) recordAuditOutcome(db, HUNTER, "pass", NOW);
    expect(economics.releaseHeldPayments()).toBe(1);
  });
});

describe("tier gating on audit apprenticeship (G0.2)", () => {
  it("queued settlements only promote past T0 once CV >= 10; paid always counts", () => {
    const db = openDb();
    insertHeartbeatBounty(db);
    db.prepare(
      `INSERT INTO bounty_settlements
         (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
          amount_usdc, oracle_verdict, judge_capped, status, created_at)
       VALUES ('s1', 'hb-1', 'c1', 'poster-pk', ?, ?, 0.5, 'pass', 0, 'queued', ?)`,
    ).run(HUNTER, WALLET, NOW);

    // Pre-audit queued row: no promotion (this was the apprenticeship leak).
    expect(computeTrustTier(db, HUNTER)).toBe(0);

    // Clearing the apprenticeship makes queued rows count.
    for (let i = 0; i < 10; i++) recordAuditOutcome(db, HUNTER, "pass", NOW);
    expect(computeTrustTier(db, HUNTER)).toBe(1);

    // A paid settlement promotes regardless of CV.
    const db2 = openDb();
    insertHeartbeatBounty(db2);
    db2
      .prepare(
        `INSERT INTO bounty_settlements
           (id, bounty_id, claim_id, poster_pubkey, hunter_pubkey, hunter_wallet,
            amount_usdc, oracle_verdict, judge_capped, status, created_at)
         VALUES ('s1', 'hb-1', 'c1', 'poster-pk', ?, ?, 0.5, 'pass', 0, 'paid', ?)`,
      )
      .run(HUNTER, WALLET, NOW);
    expect(computeTrustTier(db2, HUNTER)).toBe(1);
  });
});
