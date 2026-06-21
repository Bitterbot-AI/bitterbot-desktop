import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { GroupBuyDirectory } from "./directory.js";
import { generateKeyPair, makeEnvelope } from "./envelope.js";
import { DemandMatcher } from "./matcher.js";
import {
  buildCommitResponse,
  type CommitRequestBody,
  type Eip3009Authorization,
  type Eip3009Signer,
  MandateError,
  type QuoteProvider,
  ReverificationError,
  type SettlementExecutor,
  ThresholdSettlement,
} from "./settlement.js";
import { canonicalizeSku } from "./sku.js";

const NOW = 1_000_000;
const SKU = canonicalizeSku({ category: "keycap-set", colorway: "nautilus", version: 1 });
const SUPPLIER_WALLET = "0xfee0000000000000000000000000000000000fee";

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

function signer(wallet: string): Eip3009Signer {
  return {
    walletAddress: () => wallet,
    signTransfer: async (p) => ({ ...p, signature: `0x${"11".repeat(65)}` }),
  };
}
const goodQuote: QuoteProvider = {
  getQuote: async () => ({ unit_price_usdc: 38, supplier_wallet: SUPPLIER_WALLET }),
};

function fakeExecutor(failFrom = new Set<string>()): SettlementExecutor & { calls: number } {
  return {
    calls: 0,
    async capture(auth: Eip3009Authorization) {
      this.calls += 1;
      if (failFrom.has(auth.from)) {
        throw new Error("insufficient funds");
      }
      return { txHash: `0x${"aa".repeat(32)}` };
    },
  };
}

function commitReq(syndicateId: string): CommitRequestBody {
  return {
    syndicate_id: syndicateId,
    sku_canonical: SKU,
    unit_price_usdc: 38,
    supplier_wallet: SUPPLIER_WALLET,
    supplier_a2a_url: "https://supplier.example/a2a",
    deposit_bps: 4000,
    strike_deadline: NOW + 1000,
  };
}

// Seed a forming syndicate with `moq` members via the real directory + matcher.
function seedSyndicate(db: DatabaseSync, moq: number) {
  const dir = new GroupBuyDirectory(db);
  dir.ingestOffer(
    makeEnvelope(
      "offer",
      {
        sku_canonical: SKU,
        sku_description: "Nautilus keycaps",
        unit_price_usdc: 38,
        moq,
        lead_time_days: 84,
        supplier_wallet: SUPPLIER_WALLET,
        supplier_a2a_url: "https://supplier.example/a2a",
        deposit_bps: 4000,
        expires_at: NOW + 100_000,
      },
      generateKeyPair(),
      NOW,
    ),
    { now: NOW },
  );
  for (let i = 0; i < moq; i++) {
    dir.ingestIntent(
      makeEnvelope(
        "intent",
        {
          sku_canonical: SKU,
          sku_description: "want it",
          max_price_usdc: 65,
          qty: 1,
          lead_time_max_days: 140,
          expires_at: NOW + 100_000,
          mandate: {
            max_total_usdc: 65,
            settlement: "eip3009",
            buyer_wallet: "0xabc",
            chain: "base",
            token: "usdc",
          },
        },
        generateKeyPair(),
        NOW,
      ),
      { now: NOW },
    );
  }
  const syndicate = new DemandMatcher(db, "ed25519:coord").evaluate(SKU, { now: NOW })!;
  const members = db
    .prepare(`SELECT id, buyer_pubkey FROM group_buy_members WHERE syndicate_id = ?`)
    .all(syndicate.id) as Array<{ id: string; buyer_pubkey: string }>;
  return { syndicateId: syndicate.id, members };
}

describe("buildCommitResponse (member side, §7.2)", () => {
  it("re-verifies, signs both legs, and splits the deposit by deposit_bps", async () => {
    const res = await buildCommitResponse(commitReq("s1"), {
      signer: signer("0xb0"),
      quoteProvider: goodQuote,
      mandateMaxTotalUsdc: 65,
      qty: 1,
      now: NOW,
    });
    expect(res.reverified).toBe(true);
    expect(res.deposit_auth.value).toBe("15200000"); // 38 * 40% = 15.2 USDC
    expect(res.balance_auth.value).toBe("22800000");
    expect(res.deposit_auth.to).toBe(SUPPLIER_WALLET);
  });

  it("refuses to sign when the supplier's own quote disagrees (anti-front-running)", async () => {
    const evilQuote: QuoteProvider = {
      getQuote: async () => ({
        unit_price_usdc: 38,
        supplier_wallet: "0xdead00000000000000000000000000000000dead",
      }),
    };
    await expect(
      buildCommitResponse(commitReq("s1"), {
        signer: signer("0xb0"),
        quoteProvider: evilQuote,
        mandateMaxTotalUsdc: 65,
        qty: 1,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ReverificationError);
  });

  it("refuses to sign beyond the mandate cap", async () => {
    await expect(
      buildCommitResponse(commitReq("s1"), {
        signer: signer("0xb0"),
        quoteProvider: goodQuote,
        mandateMaxTotalUsdc: 10,
        qty: 1,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MandateError);
  });
});

describe("ThresholdSettlement (coordinator side)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
  });

  async function commitFor(memberId: string, syndicateId: string, wallet: string) {
    const body = await buildCommitResponse(commitReq(syndicateId), {
      signer: signer(wallet),
      quoteProvider: goodQuote,
      mandateMaxTotalUsdc: 65,
      qty: 1,
      now: NOW,
    });
    return { memberId, body };
  }

  it("rejects a commit that was not re-verified", () => {
    const { syndicateId, members } = seedSyndicate(db, 1);
    const settlement = new ThresholdSettlement(db, fakeExecutor());
    const res = settlement.recordCommitment(syndicateId, members[0]!.id, {
      syndicate_id: syndicateId,
      deposit_auth: {} as Eip3009Authorization,
      balance_auth: {} as Eip3009Authorization,
      reverified: false,
    });
    expect(res.ok).toBe(false);
  });

  it("aborts the strike (captures nothing) when commitments are under MOQ", async () => {
    const { syndicateId, members } = seedSyndicate(db, 2);
    const executor = fakeExecutor();
    const settlement = new ThresholdSettlement(db, executor);
    const c = await commitFor(members[0]!.id, syndicateId, "0xb0"); // only 1 of 2
    settlement.recordCommitment(syndicateId, c.memberId, c.body, NOW);

    const result = await settlement.strike(syndicateId, NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/under MOQ/);
    expect(executor.calls).toBe(0); // confirm-then-capture: nothing captured
  });

  it("captures deposits and settles when MOQ is met, feeding reputation", async () => {
    const { syndicateId, members } = seedSyndicate(db, 2);
    const executor = fakeExecutor();
    const events: Array<{ outcome: string; amount: number }> = [];
    const settlement = new ThresholdSettlement(db, executor, {
      reputation: {
        recordSettlementOutcome: (_p, _r, outcome, amount) => events.push({ outcome, amount }),
      },
    });
    for (const [i, m] of members.entries()) {
      const c = await commitFor(m.id, syndicateId, `0xb${i}`);
      settlement.recordCommitment(syndicateId, c.memberId, c.body, NOW);
    }

    const result = await settlement.strike(syndicateId, NOW);
    expect(result).toMatchObject({ ok: true, settledCount: 2, moq: 2 });
    expect(executor.calls).toBe(2);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.outcome === "settled" && e.amount === 15.2)).toBe(true);
    const status = db
      .prepare(`SELECT status FROM group_buy_syndicates WHERE id = ?`)
      .get(syndicateId) as { status: string };
    expect(status.status).toBe("settled");
  });

  it("a single capture failure defaults that member; the rest settle", async () => {
    const { syndicateId, members } = seedSyndicate(db, 2);
    const executor = fakeExecutor(new Set(["0xb1"])); // member 1's wallet fails
    const events: Array<{ outcome: string }> = [];
    const settlement = new ThresholdSettlement(db, executor, {
      reputation: { recordSettlementOutcome: (_p, _r, outcome) => events.push({ outcome }) },
    });
    for (const [i, m] of members.entries()) {
      const c = await commitFor(m.id, syndicateId, `0xb${i}`);
      settlement.recordCommitment(syndicateId, c.memberId, c.body, NOW);
    }

    const result = await settlement.strike(syndicateId, NOW);
    expect(result.settledCount).toBe(1);
    expect(result.ok).toBe(false); // 1 < moq 2
    expect(events.filter((e) => e.outcome === "settled")).toHaveLength(1);
    expect(events.filter((e) => e.outcome === "defaulted")).toHaveLength(1);
  });
});
