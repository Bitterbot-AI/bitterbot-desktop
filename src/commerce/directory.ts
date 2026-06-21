import type { DatabaseSync } from "node:sqlite";
/**
 * Offer/Intent Directory — PLAN-26 Primitive 1, the local index over signed
 * Aubaine offers and intents (docs/protocol/aubaine-v1 §6 list endpoints).
 *
 * Transport-agnostic: it ingests validated `Envelope`s regardless of whether
 * they arrived over the HTTP clearinghouse surface or the libp2p gossip mesh,
 * and persists them into the migration-v20 tables. Dedup key is
 * (author_pubkey, sku_canonical) — one standing offer/intent per party per SKU —
 * so re-broadcasts upsert rather than duplicate.
 *
 * All timestamps in these tables are UNIX SECONDS, matching the protocol
 * envelope `ts`/`expires_at` fields.
 */
import { createHash } from "node:crypto";
import { type Envelope, validateEnvelope } from "./envelope.js";

export interface IngestResult {
  ok: boolean;
  error?: string;
}

export interface OfferRow {
  id: string;
  sku_canonical: string;
  sku_description: string;
  unit_price_usdc: number;
  moq: number;
  lead_time_days: number;
  supplier_pubkey: string;
  supplier_a2a_url: string;
  supplier_wallet: string | null;
  deposit_bps: number;
  expires_at: number;
}

export interface IntentRow {
  id: string;
  sku_canonical: string;
  sku_description: string;
  max_price_usdc: number;
  qty: number;
  lead_time_max_days: number;
  buyer_pubkey: string;
  expires_at: number;
}

function rowId(pubkey: string, sku: string): string {
  return createHash("sha256").update(`${pubkey}|${sku}`).digest("hex").slice(0, 32);
}

function nowSeconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

export class GroupBuyDirectory {
  constructor(private readonly db: DatabaseSync) {}

  ingestOffer(env: Envelope, opts: { now?: number; peerId?: string } = {}): IngestResult {
    const valid = validateEnvelope(env, { now: opts.now, expectedType: "offer" });
    if (!valid.ok) {
      return valid;
    }
    const b = env.body;
    if (
      typeof b.sku_canonical !== "string" ||
      typeof b.sku_description !== "string" ||
      typeof b.unit_price_usdc !== "number" ||
      typeof b.moq !== "number" ||
      typeof b.lead_time_days !== "number" ||
      typeof b.supplier_a2a_url !== "string" ||
      typeof b.expires_at !== "number"
    ) {
      return { ok: false, error: "malformed offer body" };
    }
    const now = nowSeconds(opts.now);
    if (b.expires_at <= now) {
      return { ok: false, error: "offer already expired" };
    }
    const id = rowId(env.author_pubkey, b.sku_canonical);
    this.db
      .prepare(
        `INSERT INTO group_buy_offers
           (id, sku_canonical, sku_description, unit_price_usdc, moq, lead_time_days,
            supplier_peer_id, supplier_pubkey, supplier_a2a_url, supplier_wallet, deposit_bps,
            expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           sku_description=excluded.sku_description, unit_price_usdc=excluded.unit_price_usdc,
           moq=excluded.moq, lead_time_days=excluded.lead_time_days,
           supplier_a2a_url=excluded.supplier_a2a_url, supplier_wallet=excluded.supplier_wallet,
           deposit_bps=excluded.deposit_bps, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        b.sku_canonical,
        b.sku_description,
        b.unit_price_usdc,
        b.moq,
        b.lead_time_days,
        opts.peerId ?? null,
        env.author_pubkey,
        b.supplier_a2a_url,
        typeof b.supplier_wallet === "string" ? b.supplier_wallet : null,
        typeof b.deposit_bps === "number" ? b.deposit_bps : 4000,
        b.expires_at,
        now,
        now,
      );
    return { ok: true };
  }

  ingestIntent(
    env: Envelope,
    opts: { now?: number; peerId?: string; isLocal?: boolean } = {},
  ): IngestResult {
    const valid = validateEnvelope(env, { now: opts.now, expectedType: "intent" });
    if (!valid.ok) {
      return valid;
    }
    const b = env.body;
    if (
      typeof b.sku_canonical !== "string" ||
      typeof b.sku_description !== "string" ||
      typeof b.max_price_usdc !== "number" ||
      typeof b.qty !== "number" ||
      typeof b.lead_time_max_days !== "number" ||
      typeof b.expires_at !== "number"
    ) {
      return { ok: false, error: "malformed intent body" };
    }
    const now = nowSeconds(opts.now);
    if (b.expires_at <= now) {
      return { ok: false, error: "intent already expired" };
    }
    const id = rowId(env.author_pubkey, b.sku_canonical);
    this.db
      .prepare(
        `INSERT INTO group_buy_intents
           (id, sku_canonical, sku_description, max_price_usdc, qty, lead_time_max_days,
            buyer_peer_id, buyer_pubkey, is_local, mandate_json, expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           sku_description=excluded.sku_description, max_price_usdc=excluded.max_price_usdc,
           qty=excluded.qty, lead_time_max_days=excluded.lead_time_max_days,
           mandate_json=excluded.mandate_json, expires_at=excluded.expires_at,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        b.sku_canonical,
        b.sku_description,
        b.max_price_usdc,
        b.qty,
        b.lead_time_max_days,
        opts.peerId ?? null,
        env.author_pubkey,
        opts.isLocal ? 1 : 0,
        JSON.stringify(b.mandate ?? {}),
        b.expires_at,
        now,
        now,
      );
    return { ok: true };
  }

  findOffers(skuCanonical: string, now?: number): OfferRow[] {
    return this.db
      .prepare(
        `SELECT id, sku_canonical, sku_description, unit_price_usdc, moq, lead_time_days,
                supplier_pubkey, supplier_a2a_url, supplier_wallet, deposit_bps, expires_at
           FROM group_buy_offers
          WHERE sku_canonical = ? AND expires_at > ?
          ORDER BY unit_price_usdc ASC`,
      )
      .all(skuCanonical, nowSeconds(now)) as unknown as OfferRow[];
  }

  findIntents(skuCanonical: string, now?: number): IntentRow[] {
    return this.db
      .prepare(
        `SELECT id, sku_canonical, sku_description, max_price_usdc, qty, lead_time_max_days,
                buyer_pubkey, expires_at
           FROM group_buy_intents
          WHERE sku_canonical = ? AND expires_at > ?
          ORDER BY created_at ASC`,
      )
      .all(skuCanonical, nowSeconds(now)) as unknown as IntentRow[];
  }

  pruneExpired(now?: number): number {
    const ts = nowSeconds(now);
    const a = this.db.prepare(`DELETE FROM group_buy_offers WHERE expires_at <= ?`).run(ts);
    const b = this.db.prepare(`DELETE FROM group_buy_intents WHERE expires_at <= ?`).run(ts);
    return Number(a.changes) + Number(b.changes);
  }
}
