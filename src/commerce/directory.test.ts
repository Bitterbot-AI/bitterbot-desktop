import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { GroupBuyDirectory } from "./directory.js";
import { type Envelope, generateKeyPair, type KeyPair, makeEnvelope } from "./envelope.js";
import { DemandMatcher } from "./matcher.js";
import { canonicalizeSku, type JsonValue } from "./sku.js";

const NOW = 1_000_000;
const SKU = canonicalizeSku({ category: "keycap-set", colorway: "nautilus", version: 1 });

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

function offerEnvelope(key: KeyPair, over: Record<string, JsonValue> = {}): Envelope {
  return makeEnvelope(
    "offer",
    {
      sku_canonical: SKU,
      sku_description: "Cherry PBT keycap set, Nautilus v1",
      unit_price_usdc: 38,
      moq: 2,
      lead_time_days: 84,
      supplier_wallet: "0xfee0000000000000000000000000000000000fee",
      supplier_a2a_url: "https://supplier.example/a2a",
      deposit_bps: 4000,
      expires_at: NOW + 100_000,
      ...over,
    },
    key,
    NOW,
  );
}

function intentEnvelope(key: KeyPair, over: Record<string, JsonValue> = {}): Envelope {
  return makeEnvelope(
    "intent",
    {
      sku_canonical: SKU,
      sku_description: "want the Nautilus set",
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
      ...over,
    },
    key,
    NOW,
  );
}

describe("GroupBuyDirectory ingest + query", () => {
  let db: DatabaseSync;
  let dir: GroupBuyDirectory;
  beforeEach(() => {
    db = openDb();
    dir = new GroupBuyDirectory(db);
  });

  it("ingests a signed offer and finds it by SKU", () => {
    expect(dir.ingestOffer(offerEnvelope(generateKeyPair()), { now: NOW }).ok).toBe(true);
    const offers = dir.findOffers(SKU, NOW);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.unit_price_usdc).toBe(38);
  });

  it("rejects a tampered envelope", () => {
    const env = offerEnvelope(generateKeyPair());
    env.body.unit_price_usdc = 1;
    const res = dir.ingestOffer(env, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid signature");
  });

  it("rejects an expired offer and a wrong-typed envelope", () => {
    expect(
      dir.ingestOffer(offerEnvelope(generateKeyPair(), { expires_at: NOW - 1 }), { now: NOW }).ok,
    ).toBe(false);
    expect(dir.ingestIntent(offerEnvelope(generateKeyPair()), { now: NOW }).ok).toBe(false);
  });

  it("upserts re-broadcasts from the same supplier (no duplicate)", () => {
    const key = generateKeyPair();
    dir.ingestOffer(offerEnvelope(key), { now: NOW });
    dir.ingestOffer(offerEnvelope(key, { unit_price_usdc: 35 }), { now: NOW });
    const offers = dir.findOffers(SKU, NOW);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.unit_price_usdc).toBe(35);
  });

  it("prunes expired rows", () => {
    dir.ingestOffer(offerEnvelope(generateKeyPair()), { now: NOW });
    expect(dir.pruneExpired(NOW + 200_000)).toBe(1);
    expect(dir.findOffers(SKU, NOW + 200_000)).toHaveLength(0);
  });
});

describe("DemandMatcher", () => {
  let db: DatabaseSync;
  let dir: GroupBuyDirectory;
  let matcher: DemandMatcher;
  beforeEach(() => {
    db = openDb();
    dir = new GroupBuyDirectory(db);
    matcher = new DemandMatcher(db, "ed25519:coordinator");
  });

  it("forms a syndicate when intents cover the MOQ", () => {
    dir.ingestOffer(offerEnvelope(generateKeyPair()), { now: NOW }); // moq 2
    dir.ingestIntent(intentEnvelope(generateKeyPair()), { now: NOW }); // qty 1
    dir.ingestIntent(intentEnvelope(generateKeyPair()), { now: NOW }); // qty 1 -> covers 2
    const syndicate = matcher.evaluate(SKU, { now: NOW });
    expect(syndicate).not.toBeNull();
    expect(syndicate?.status).toBe("forming");
    expect(syndicate?.member_count).toBe(2);
  });

  it("does not form when under MOQ", () => {
    dir.ingestOffer(offerEnvelope(generateKeyPair()), { now: NOW });
    dir.ingestIntent(intentEnvelope(generateKeyPair()), { now: NOW }); // only qty 1 of 2
    expect(matcher.evaluate(SKU, { now: NOW })).toBeNull();
  });

  it("excludes intents whose max price is below the offer unit price", () => {
    dir.ingestOffer(offerEnvelope(generateKeyPair()), { now: NOW });
    dir.ingestIntent(intentEnvelope(generateKeyPair(), { max_price_usdc: 10 }), { now: NOW });
    dir.ingestIntent(intentEnvelope(generateKeyPair(), { max_price_usdc: 10 }), { now: NOW });
    expect(matcher.evaluate(SKU, { now: NOW })).toBeNull();
  });

  it("is idempotent — re-evaluating returns the existing active syndicate", () => {
    dir.ingestOffer(offerEnvelope(generateKeyPair()), { now: NOW });
    dir.ingestIntent(intentEnvelope(generateKeyPair()), { now: NOW });
    dir.ingestIntent(intentEnvelope(generateKeyPair()), { now: NOW });
    const first = matcher.evaluate(SKU, { now: NOW });
    const second = matcher.evaluate(SKU, { now: NOW });
    expect(second?.id).toBe(first?.id);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM group_buy_syndicates`).get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});
