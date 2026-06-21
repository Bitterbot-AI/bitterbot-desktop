import type { DatabaseSync } from "node:sqlite";
/**
 * Demand Matcher — PLAN-26 Primitive 2.
 *
 * For a SKU, finds the best (lowest-price, non-expired) offer and the set of
 * intents that satisfy it (max_price >= unit_price AND lead_time tolerance >=
 * offer lead time). When the matched intents' quantity covers the offer's MOQ,
 * it forms a syndicate: a `group_buy_syndicates` row plus one `invited`
 * `group_buy_members` row per matching intent.
 *
 * Antitrust invariant (PLAN-26 §6.1): the matcher reads public offers/intents
 * and optimizes one buyer's fill; it never circulates one buyer's price to
 * another buyer to coordinate a common price. Intents are non-binding here —
 * only signed deposit authorizations at strike (Phase 3) count toward a real
 * commitment, which also defeats Sybil MOQ inflation.
 *
 * Timestamps are UNIX SECONDS (protocol-aligned).
 */
import { createHash } from "node:crypto";
import { GroupBuyDirectory } from "./directory.js";

const ACTIVE_SYNDICATE_STATES = ["forming", "quoting", "committing", "striking"];
const DEFAULT_STRIKE_WINDOW_SECONDS = 7 * 24 * 3600;

export interface SyndicateRow {
  id: string;
  offer_id: string;
  sku_canonical: string;
  unit_price_usdc: number;
  moq: number;
  committed_qty: number;
  status: string;
  member_count: number;
}

export interface MatcherOptions {
  now?: number;
  strikeWindowSeconds?: number;
}

export class DemandMatcher {
  private readonly directory: GroupBuyDirectory;

  constructor(
    private readonly db: DatabaseSync,
    private readonly coordinatorPubkey: string,
  ) {
    this.directory = new GroupBuyDirectory(db);
  }

  /**
   * Evaluate one SKU. Returns the syndicate if a new one was formed (or an
   * already-active one exists), else null.
   */
  evaluate(skuCanonical: string, opts: MatcherOptions = {}): SyndicateRow | null {
    const now = opts.now ?? Math.floor(Date.now() / 1000);

    const existing = this.db
      .prepare(
        `SELECT id FROM group_buy_syndicates
          WHERE sku_canonical = ? AND status IN (${ACTIVE_SYNDICATE_STATES.map(() => "?").join(",")})
          LIMIT 1`,
      )
      .get(skuCanonical, ...ACTIVE_SYNDICATE_STATES) as { id: string } | undefined;
    if (existing) {
      return this.getSyndicate(existing.id);
    }

    const offers = this.directory.findOffers(skuCanonical, now);
    if (offers.length === 0) {
      return null;
    }
    const offer = offers[0]!; // lowest unit price

    const matching = this.directory
      .findIntents(skuCanonical, now)
      .filter(
        (i) =>
          i.max_price_usdc >= offer.unit_price_usdc && i.lead_time_max_days >= offer.lead_time_days,
      );
    const coveredQty = matching.reduce((sum, i) => sum + i.qty, 0);
    if (coveredQty < offer.moq) {
      return null;
    }

    return this.formSyndicate(offer, matching, now, opts.strikeWindowSeconds);
  }

  private formSyndicate(
    offer: ReturnType<GroupBuyDirectory["findOffers"]>[number],
    intents: ReturnType<GroupBuyDirectory["findIntents"]>,
    now: number,
    strikeWindowSeconds?: number,
  ): SyndicateRow {
    const syndicateId = createHash("sha256")
      .update(`${offer.id}|${offer.supplier_pubkey}|${now}`)
      .digest("hex")
      .slice(0, 32);
    const strikeDeadline = now + (strikeWindowSeconds ?? DEFAULT_STRIKE_WINDOW_SECONDS);

    this.db
      .prepare(
        `INSERT INTO group_buy_syndicates
           (id, offer_id, sku_canonical, unit_price_usdc, moq, committed_qty, status,
            supplier_pubkey, supplier_a2a_url, coordinator_peer_id, strike_deadline,
            created_at, updated_at)
         VALUES (?,?,?,?,?,0,'forming',?,?,?,?,?,?)`,
      )
      .run(
        syndicateId,
        offer.id,
        offer.sku_canonical,
        offer.unit_price_usdc,
        offer.moq,
        offer.supplier_pubkey,
        offer.supplier_a2a_url,
        this.coordinatorPubkey,
        strikeDeadline,
        now,
        now,
      );

    const insertMember = this.db.prepare(
      `INSERT INTO group_buy_members
         (id, syndicate_id, intent_id, buyer_pubkey, buyer_peer_id, qty, amount_usdc,
          commit_status, updated_at)
       VALUES (?,?,?,?,?,?,?, 'invited', ?)`,
    );
    for (const intent of intents) {
      const memberId = createHash("sha256")
        .update(`${syndicateId}|${intent.id}`)
        .digest("hex")
        .slice(0, 32);
      insertMember.run(
        memberId,
        syndicateId,
        intent.id,
        intent.buyer_pubkey,
        null,
        intent.qty,
        intent.qty * offer.unit_price_usdc,
        now,
      );
    }

    return this.getSyndicate(syndicateId)!;
  }

  getSyndicate(id: string): SyndicateRow | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.offer_id, s.sku_canonical, s.unit_price_usdc, s.moq, s.committed_qty,
                s.status, COUNT(m.id) AS member_count
           FROM group_buy_syndicates s
           LEFT JOIN group_buy_members m ON m.syndicate_id = s.id
          WHERE s.id = ?
          GROUP BY s.id`,
      )
      .get(id) as SyndicateRow | undefined;
    return row ?? null;
  }
}
