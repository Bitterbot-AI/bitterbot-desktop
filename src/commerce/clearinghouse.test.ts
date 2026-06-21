import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import { type ClearinghouseEvent, ClearinghouseService } from "./clearinghouse.js";
import { type Envelope, generateKeyPair, type KeyPair, makeEnvelope } from "./envelope.js";
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

function offer(key: KeyPair, over: Record<string, JsonValue> = {}): Envelope {
  return makeEnvelope(
    "offer",
    {
      sku_canonical: SKU,
      sku_description: "Nautilus keycaps",
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

function intent(key: KeyPair): Envelope {
  return makeEnvelope(
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
    key,
    NOW,
  );
}

describe("ClearinghouseService", () => {
  let service: ClearinghouseService;
  beforeEach(() => {
    service = new ClearinghouseService(openDb(), "ed25519:coordinator");
  });

  it("accepts a valid offer and lists it", () => {
    expect(service.submitOffer(offer(generateKeyPair()), NOW).ok).toBe(true);
    expect(service.listOffers(SKU, NOW)).toHaveLength(1);
  });

  it("rejects a tampered envelope with an error", () => {
    const env = offer(generateKeyPair());
    env.body.unit_price_usdc = 1;
    const res = service.submitOffer(env, NOW);
    expect(res.ok).toBe(false);
  });

  it("forms a syndicate when the covering intent arrives, and emits exactly once", () => {
    const events: ClearinghouseEvent[] = [];
    service.subscribe((e) => events.push(e));

    service.submitOffer(offer(generateKeyPair()), NOW); // moq 2, no match yet
    expect(service.submitIntent(intent(generateKeyPair()), NOW).matched).toBeNull(); // 1 of 2
    const second = service.submitIntent(intent(generateKeyPair()), NOW); // 2 of 2 -> forms
    expect(second.ok && second.matched?.status).toBe("forming");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("syndicate_forming");
    expect(service.listSyndicates(SKU)).toHaveLength(1);
  });

  it("does not re-emit for an already-active syndicate on further submissions", () => {
    const events: ClearinghouseEvent[] = [];
    service.subscribe((e) => events.push(e));
    service.submitOffer(offer(generateKeyPair()), NOW);
    service.submitIntent(intent(generateKeyPair()), NOW);
    service.submitIntent(intent(generateKeyPair()), NOW); // forms
    service.submitIntent(intent(generateKeyPair()), NOW); // a 3rd buyer, already active
    expect(events).toHaveLength(1);
  });
});
