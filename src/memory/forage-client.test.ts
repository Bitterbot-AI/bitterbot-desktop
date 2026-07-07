import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { getMorningReportLine } from "./bounty-tape.js";
import {
  nightShiftSweep,
  parseMonitorUrl,
  parsePosterA2aUrl,
  type FetchLike,
} from "./forage-client.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

// PLAN-29 Phase 5: the Night Shift claims capped heartbeat bounties from
// the mesh, sends cadence-respecting checks against real observations,
// records earnings in the claim mirror, and surfaces them in the morning
// report. All network via injected fetch; nothing leaves the test.

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const MY_WALLET = "0x3333333333333333333333333333333333333333";

const SPEC = `Watch the pricing page daily.
{"heartbeat": {"cadenceSeconds": 86400, "perCheckUsdc": 0.05, "alertBonusUsdc": 0, "url": "https://target.example/pricing"}, "posterA2aUrl": "https://poster.example"}`;

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

function insertRemoteBounty(db: DatabaseSync, over: Partial<{ id: string; reward: number }> = {}) {
  db.prepare(
    `INSERT INTO bounty_posts
       (bounty_id, poster_pubkey, poster_wallet, kind, category, spec_public,
        oracle_commitment, oracle_type, reward_usdc, claim_stake_usdc, max_claims,
        is_local, status, expires_at, created_at, updated_at)
     VALUES (?, 'remote-poster', '0x1111111111111111111111111111111111111111', 'heartbeat',
             'monitoring', ?, 'sha256:x', 'mechanical', ?, 0, 1, 0, 'open', ?, ?, ?)`,
  ).run(over.id ?? "rb-1", SPEC, over.reward ?? 1, NOW + 365 * DAY_MS, NOW, NOW);
}

/** Fetch stub: serves the monitored page and a scripted poster A2A. */
function makeFetch(
  opts: {
    claimOk?: boolean;
    checkinError?: string;
    claimNonce?: string;
    verdictResult?: Record<string, unknown>;
  } = {},
): {
  fetch: FetchLike;
  rpcCalls: Array<{ method: string; params: Record<string, unknown> }>;
  setPage: (body: string) => void;
} {
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let pageBody = "page content v1";
  const fetch: FetchLike = async (url, init) => {
    if (url.startsWith("https://target.example")) {
      return { ok: true, status: 200, text: async () => pageBody };
    }
    const req = JSON.parse(init?.body ?? "{}") as {
      method: string;
      params: Record<string, unknown>;
      id: string;
    };
    rpcCalls.push({ method: req.method, params: req.params });
    let body: Record<string, unknown>;
    if (req.method === "forage/claim") {
      body =
        opts.claimOk === false
          ? { error: { message: "Bounty is fully claimed" } }
          : {
              result: {
                claimId: "claim-" + req.params.bountyId,
                status: "claimed",
                ...(opts.claimNonce ? { claimNonce: opts.claimNonce } : {}),
              },
            };
    } else if (req.method === "forage/checkin") {
      body = opts.checkinError
        ? { error: { message: opts.checkinError } }
        : { result: { checksTotal: 1, streamStatus: "active" } };
    } else {
      body = { result: opts.verdictResult ?? { verdict: null } };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return {
    fetch,
    rpcCalls,
    setPage: (body: string) => {
      pageBody = body;
    },
  };
}

function sweep(db: DatabaseSync, fetch: FetchLike, now = NOW, config = {}) {
  return nightShiftSweep({
    db,
    hunterPubkey: MY_WALLET,
    hunterWallet: MY_WALLET,
    fetchImpl: fetch,
    config,
    now,
  });
}

describe("spec parsing", () => {
  it("extracts poster callback and monitor URLs", () => {
    expect(parsePosterA2aUrl(SPEC)).toBe("https://poster.example");
    expect(parseMonitorUrl(SPEC)).toBe("https://target.example/pricing");
    expect(parsePosterA2aUrl("no urls")).toBeNull();
  });
});

describe("nightShiftSweep", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
  });

  it("claims an eligible mesh bounty and mirrors it locally", async () => {
    insertRemoteBounty(db);
    const { fetch, rpcCalls } = makeFetch();
    const res = await sweep(db, fetch);
    expect(res.claimed).toBe(1);
    expect(rpcCalls[0].method).toBe("forage/claim");
    const hunt = db.prepare(`SELECT * FROM forage_hunts`).get() as Record<string, unknown>;
    expect(hunt.bounty_id).toBe("rb-1");
    expect(hunt.status).toBe("claimed");
    expect(hunt.monitor_url).toBe("https://target.example/pricing");
  });

  it("sends a due check on the next sweep and records earnings", async () => {
    insertRemoteBounty(db);
    const { fetch, rpcCalls } = makeFetch();
    await sweep(db, fetch, NOW);
    const res = await sweep(db, fetch, NOW + DAY_MS + 1000);
    expect(res.checksSent).toBe(1);
    const checkin = rpcCalls.find((c) => c.method === "forage/checkin");
    expect(checkin).toBeTruthy();
    const obs = checkin?.params.observation as { contentHash: string };
    expect(obs.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const hunt = db.prepare(`SELECT earned_usdc, checks_sent FROM forage_hunts`).get() as {
      earned_usdc: number;
      checks_sent: number;
    };
    expect(hunt.checks_sent).toBe(1);
    expect(hunt.earned_usdc).toBeCloseTo(0.05);
  });

  it("respects cadence: no premature checks", async () => {
    insertRemoteBounty(db);
    const { fetch } = makeFetch();
    await sweep(db, fetch, NOW);
    await sweep(db, fetch, NOW + DAY_MS + 1000);
    const res = await sweep(db, fetch, NOW + DAY_MS + 2000); // 1s after last check
    expect(res.checksSent).toBe(0);
  });

  it("caps concurrent hunts and per-bounty reward", async () => {
    insertRemoteBounty(db, { id: "rb-1" });
    insertRemoteBounty(db, { id: "rb-2" });
    insertRemoteBounty(db, { id: "rb-3" });
    insertRemoteBounty(db, { id: "rb-rich", reward: 50 });
    const { fetch } = makeFetch();
    const res = await sweep(db, fetch, NOW, { maxConcurrentHunts: 2 });
    expect(res.claimed).toBe(2);
    const hunted = db.prepare(`SELECT bounty_id FROM forage_hunts`).all() as unknown as Array<{
      bounty_id: string;
    }>;
    expect(hunted.map((h) => h.bounty_id)).not.toContain("rb-rich"); // $50 > $2 cap
  });

  it("completes the hunt when the poster reports the stream ended", async () => {
    insertRemoteBounty(db);
    const good = makeFetch();
    await sweep(db, good.fetch, NOW);
    const ended = makeFetch({ checkinError: "Stream is not active (status: completed)" });
    await sweep(db, ended.fetch, NOW + DAY_MS + 1000);
    const hunt = db.prepare(`SELECT status FROM forage_hunts`).get() as { status: string };
    expect(hunt.status).toBe("completed");
  });

  it("stays idle when disabled", async () => {
    insertRemoteBounty(db);
    const { fetch, rpcCalls } = makeFetch();
    const res = await sweep(db, fetch, NOW, { enabled: false });
    expect(res.claimed).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("hunter earnings surface in the morning report", async () => {
    insertRemoteBounty(db);
    const { fetch } = makeFetch();
    await sweep(db, fetch, NOW);
    await sweep(db, fetch, NOW + DAY_MS + 1000);
    const line = getMorningReportLine(db, NOW + DAY_MS + 2000);
    // PLAN-30 G0.5: unreconciled earnings report as accrued, never "earned".
    expect(line).toMatch(/accrued \$0\.05 \(pending verification\) hunting 1 bounty/);
  });

  it("reports confirmed earnings once the poster's settlement is paid", async () => {
    insertRemoteBounty(db);
    const { fetch } = makeFetch({
      verdictResult: { claimStatus: "verified", settlementStatus: "paid", txHash: "0xabc" },
    });
    await sweep(db, fetch, NOW);
    await sweep(db, fetch, NOW + DAY_MS + 1000);
    // Reconciliation ran inside the sweep (earned > 0, not yet paid).
    const hunt = db.prepare(`SELECT settlement_status, settlement_tx FROM forage_hunts`).get() as {
      settlement_status: string | null;
      settlement_tx: string | null;
    };
    expect(hunt.settlement_status).toBe("paid");
    expect(hunt.settlement_tx).toBe("0xabc");
    const line = getMorningReportLine(db, NOW + DAY_MS + 2000);
    expect(line).toMatch(/earned \$0\.05 hunting 1 bounty while you were away/);
  });
});

// PLAN-30 G0.3: v2 observations — normalized digest scheme, simhash, the
// nonce-sealed digest, and change-detection alerts.
describe("nightShiftSweep v2 observations (G0.3)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    insertRemoteBounty(db);
  });

  it("stores the claim nonce and seals check-ins with it", async () => {
    const { fetch, rpcCalls } = makeFetch({ claimNonce: "nonce-abc" });
    await sweep(db, fetch, NOW);
    const hunt = db.prepare(`SELECT claim_nonce FROM forage_hunts`).get() as {
      claim_nonce: string | null;
    };
    expect(hunt.claim_nonce).toBe("nonce-abc");

    await sweep(db, fetch, NOW + DAY_MS + 1000);
    const obs = rpcCalls.find((c) => c.method === "forage/checkin")?.params.observation as {
      contentHash: string;
      digestScheme: string;
      simhash: string;
      sealedDigest: string;
      alert?: boolean;
    };
    expect(obs.digestScheme).toBe("norm-v1");
    expect(obs.simhash).toMatch(/^[0-9a-f]{16}$/);
    const expectedSeal = crypto
      .createHash("sha256")
      .update("nonce-abc" + obs.contentHash, "utf-8")
      .digest("hex");
    expect(obs.sealedDigest).toBe(expectedSeal);
    expect(obs.alert).toBeUndefined(); // first observation: nothing to compare
  });

  it("omits the seal when the poster issued no nonce (legacy posters)", async () => {
    const { fetch, rpcCalls } = makeFetch();
    await sweep(db, fetch, NOW);
    await sweep(db, fetch, NOW + DAY_MS + 1000);
    const obs = rpcCalls.find((c) => c.method === "forage/checkin")?.params.observation as {
      sealedDigest?: string;
    };
    expect(obs.sealedDigest).toBeUndefined();
  });

  it("raises the alert flag when the monitored content changes", async () => {
    const { fetch, rpcCalls, setPage } = makeFetch({ claimNonce: "n" });
    await sweep(db, fetch, NOW);
    await sweep(db, fetch, NOW + DAY_MS + 1000); // baseline observation
    setPage("page content v2 CHANGED");
    await sweep(db, fetch, NOW + 2 * DAY_MS + 2000);
    const checkins = rpcCalls.filter((c) => c.method === "forage/checkin");
    expect(checkins).toHaveLength(2);
    expect((checkins[0].params.observation as { alert?: boolean }).alert).toBeUndefined();
    expect((checkins[1].params.observation as { alert?: boolean }).alert).toBe(true);
  });
});
