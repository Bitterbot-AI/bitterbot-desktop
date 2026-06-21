/**
 * Clearinghouse service — PLAN-26 §12.3, the transport-agnostic core behind the
 * agnostic HTTP surface (docs/protocol/aubaine-v1 §6). It ingests signed
 * offer/intent envelopes (from HTTP or the gossip bridge), runs the matcher, and
 * notifies subscribers when a syndicate forms. No Express, no libp2p here — both
 * transports adapt onto this.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Envelope } from "./envelope.js";
import { GroupBuyDirectory, type OfferRow } from "./directory.js";
import { DemandMatcher, type SyndicateRow } from "./matcher.js";

const ACTIVE_STATES = ["forming", "quoting", "committing", "striking"];

/** sku_canonical of an envelope whose body already passed ingest validation. */
function skuOf(env: Envelope): string {
  return typeof env.body.sku_canonical === "string" ? env.body.sku_canonical : "";
}

export interface ClearinghouseEvent {
  type: "syndicate_forming";
  syndicate: SyndicateRow;
}

export type SubmitResult =
  | { ok: true; matched: SyndicateRow | null }
  | { ok: false; error: string };

export class ClearinghouseService {
  readonly directory: GroupBuyDirectory;
  readonly matcher: DemandMatcher;
  private readonly subscribers = new Set<(event: ClearinghouseEvent) => void>();

  constructor(
    private readonly db: DatabaseSync,
    coordinatorPubkey: string,
  ) {
    this.directory = new GroupBuyDirectory(db);
    this.matcher = new DemandMatcher(db, coordinatorPubkey);
  }

  subscribe(cb: (event: ClearinghouseEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  submitOffer(env: Envelope, now?: number): SubmitResult {
    const res = this.directory.ingestOffer(env, { now });
    if (!res.ok) {
      return { ok: false, error: res.error ?? "rejected" };
    }
    return { ok: true, matched: this.tryMatch(skuOf(env), now) };
  }

  submitIntent(env: Envelope, now?: number): SubmitResult {
    const res = this.directory.ingestIntent(env, { now });
    if (!res.ok) {
      return { ok: false, error: res.error ?? "rejected" };
    }
    return { ok: true, matched: this.tryMatch(skuOf(env), now) };
  }

  listOffers(skuCanonical: string, now?: number): OfferRow[] {
    return this.directory.findOffers(skuCanonical, now);
  }

  listSyndicates(skuCanonical: string): SyndicateRow[] {
    return this.db
      .prepare(
        `SELECT s.id, s.offer_id, s.sku_canonical, s.unit_price_usdc, s.moq, s.committed_qty,
                s.status, COUNT(m.id) AS member_count
           FROM group_buy_syndicates s
           LEFT JOIN group_buy_members m ON m.syndicate_id = s.id
          WHERE s.sku_canonical = ?
          GROUP BY s.id`,
      )
      .all(skuCanonical) as unknown as SyndicateRow[];
  }

  private tryMatch(skuCanonical: string, now?: number): SyndicateRow | null {
    const before = this.activeSyndicateId(skuCanonical);
    const syndicate = this.matcher.evaluate(skuCanonical, { now });
    if (syndicate && syndicate.id !== before) {
      this.emit({ type: "syndicate_forming", syndicate });
    }
    return syndicate;
  }

  private activeSyndicateId(skuCanonical: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM group_buy_syndicates
          WHERE sku_canonical = ? AND status IN (${ACTIVE_STATES.map(() => "?").join(",")})
          LIMIT 1`,
      )
      .get(skuCanonical, ...ACTIVE_STATES) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private emit(event: ClearinghouseEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // a misbehaving subscriber must never break ingest
      }
    }
  }
}
