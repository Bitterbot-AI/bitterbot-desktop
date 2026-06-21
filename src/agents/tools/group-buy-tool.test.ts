import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { ClearinghouseService } from "../../commerce/clearinghouse.js";
import { generateKeyPair, type KeyPair, makeEnvelope } from "../../commerce/envelope.js";
import { canonicalizeSku } from "../../commerce/sku.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { createGroupBuyTool } from "./group-buy-tool.js";

const SKU = canonicalizeSku({ category: "keycap-set", colorway: "nautilus", version: 1 });

function openService(): ClearinghouseService {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return new ClearinghouseService(db, "ed25519:coordinator");
}

function seedOffer(service: ClearinghouseService, key: KeyPair, moq = 1): void {
  const now = Math.floor(Date.now() / 1000);
  service.submitOffer(
    makeEnvelope(
      "offer",
      {
        sku_canonical: SKU,
        sku_description: "Nautilus keycaps",
        unit_price_usdc: 38,
        moq,
        lead_time_days: 84,
        supplier_wallet: "0xfee0000000000000000000000000000000000fee",
        supplier_a2a_url: "https://supplier.example/a2a",
        deposit_bps: 4000,
        expires_at: now + 100_000,
      },
      key,
      now,
    ),
    now,
  );
}

async function run(tool: AnyAgentTool, args: Record<string, unknown>): Promise<unknown> {
  const result = await tool.execute("call-1", args);
  return (result as { details?: unknown }).details;
}

describe("createGroupBuyTool", () => {
  let service: ClearinghouseService;
  let signer: KeyPair;
  const enabled = { commerce: { groupbuy: { enabled: true } } };

  beforeEach(() => {
    service = openService();
    signer = generateKeyPair();
  });

  it("is undefined when the feature is disabled or unwired", () => {
    expect(createGroupBuyTool({ config: {}, service, signer })).toBeUndefined();
    expect(createGroupBuyTool({ config: enabled })).toBeUndefined(); // no service/signer
  });

  it("lists offers for a SKU", async () => {
    seedOffer(service, generateKeyPair());
    const tool = createGroupBuyTool({ config: enabled, service, signer })!;
    const offers = (await run(tool, { action: "list_offers", sku: SKU })) as unknown[];
    expect(offers).toHaveLength(1);
  });

  it("register_intent forms a syndicate when it covers the MOQ (moq=1)", async () => {
    seedOffer(service, generateKeyPair(), 1);
    const tool = createGroupBuyTool({ config: enabled, service, signer })!;
    const res = (await run(tool, {
      action: "register_intent",
      sku: SKU,
      max_price_usdc: 65,
      buyer_wallet: "0xabc0000000000000000000000000000000000abc",
    })) as { ok: boolean; matched?: { status: string } | null };
    expect(res.ok).toBe(true);
    expect(res.matched?.status).toBe("forming");
  });

  it("canonicalizes a demand-first spec_json into the matching SKU", async () => {
    seedOffer(service, generateKeyPair(), 1);
    const tool = createGroupBuyTool({ config: enabled, service, signer })!;
    const res = (await run(tool, {
      action: "register_intent",
      spec_json: JSON.stringify({ version: 1, colorway: "NAUTILUS", category: "Keycap-Set" }),
      max_price_usdc: 65,
      buyer_wallet: "0xabc0000000000000000000000000000000000abc",
    })) as { matched?: { status: string } | null };
    expect(res.matched?.status).toBe("forming");
  });

  it("rejects register_intent without a sku or spec", async () => {
    const tool = createGroupBuyTool({ config: enabled, service, signer })!;
    await expect(
      tool.execute("c", { action: "register_intent", max_price_usdc: 10, buyer_wallet: "0xabc" }),
    ).rejects.toThrow();
  });
});
