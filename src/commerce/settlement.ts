import type { DatabaseSync } from "node:sqlite";
/**
 * Threshold settlement — PLAN-26 Primitive 3 (docs/protocol/aubaine-v1 §7).
 *
 * Non-custodial, many-buyers-to-one-supplier. Each buyer signs two EIP-3009
 * `transferWithAuthorization` legs (deposit + balance) buyer-wallet ->
 * supplier-wallet; the coordinator only relays and captures, it is never the
 * payee. Two invariants are enforced here in code:
 *
 *  - Anti-front-running (§7.2): a member MUST independently re-verify the
 *    supplier's price/wallet against the supplier's own URL before signing.
 *    `buildCommitResponse` does that re-verification; the coordinator rejects
 *    any commit whose `reverified` flag is not true.
 *  - Confirm-then-capture atomicity (§7.4): the coordinator collects >= MOQ
 *    signed deposit authorizations BEFORE any on-chain capture, so a quorum
 *    failure strands nobody.
 *
 * On-chain signing and capture are behind injected interfaces, so this module
 * is fully unit-testable and carries no wallet/chain dependency itself.
 */
import crypto from "node:crypto";

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string; // USDC smallest units (6dp), decimal string
  validAfter: number;
  validBefore: number;
  nonce: string;
  signature: string;
}

export interface Eip3009Signer {
  walletAddress(): string;
  signTransfer(params: Omit<Eip3009Authorization, "signature">): Promise<Eip3009Authorization>;
}

export interface SettlementExecutor {
  /** Capture a signed authorization on-chain; resolves with the tx hash. */
  capture(auth: Eip3009Authorization): Promise<{ txHash: string }>;
}

export interface QuoteProvider {
  getQuote(
    supplierA2aUrl: string,
    skuCanonical: string,
  ): Promise<{ unit_price_usdc: number; supplier_wallet: string }>;
}

export interface CommerceReputationSink {
  recordSettlementOutcome(
    counterpartyPubkey: string,
    role: "buyer" | "supplier" | "coordinator",
    outcome: "settled" | "disputed" | "defaulted",
    amountUsdc: number,
  ): void;
}

export interface CommitRequestBody {
  syndicate_id: string;
  sku_canonical: string;
  unit_price_usdc: number;
  supplier_wallet: string;
  supplier_a2a_url: string;
  deposit_bps: number;
  strike_deadline: number;
}

export interface CommitResponseBody {
  syndicate_id: string;
  deposit_auth: Eip3009Authorization;
  balance_auth: Eip3009Authorization;
  reverified: boolean;
}

export class ReverificationError extends Error {}
export class MandateError extends Error {}

function usdcUnits(usdc: number): bigint {
  return BigInt(Math.round(usdc * 1e6));
}

function nonce(): string {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

// ── Member side ──────────────────────────────────────────────────────────

/**
 * Build a signed commit response (buyer side). Performs the mandatory
 * independent re-verification against the supplier's own URL, enforces the
 * buyer's mandate cap, then signs the deposit + balance EIP-3009 legs.
 */
export async function buildCommitResponse(
  req: CommitRequestBody,
  opts: {
    signer: Eip3009Signer;
    quoteProvider: QuoteProvider;
    mandateMaxTotalUsdc: number;
    qty: number;
    now?: number;
    validitySeconds?: number;
  },
): Promise<CommitResponseBody> {
  const quote = await opts.quoteProvider.getQuote(req.supplier_a2a_url, req.sku_canonical);
  if (
    quote.unit_price_usdc !== req.unit_price_usdc ||
    quote.supplier_wallet.toLowerCase() !== req.supplier_wallet.toLowerCase()
  ) {
    throw new ReverificationError("supplier quote does not match the coordinator's commit request");
  }

  const total = req.unit_price_usdc * opts.qty;
  if (total > opts.mandateMaxTotalUsdc) {
    throw new MandateError("commit price exceeds the signed mandate");
  }

  const totalUnits = usdcUnits(total);
  const depositUnits = (totalUnits * BigInt(req.deposit_bps)) / 10_000n;
  const balanceUnits = totalUnits - depositUnits;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const validBefore = now + (opts.validitySeconds ?? 3600);
  const from = opts.signer.walletAddress();

  const deposit_auth = await opts.signer.signTransfer({
    from,
    to: req.supplier_wallet,
    value: depositUnits.toString(),
    validAfter: 0,
    validBefore,
    nonce: nonce(),
  });
  const balance_auth = await opts.signer.signTransfer({
    from,
    to: req.supplier_wallet,
    value: balanceUnits.toString(),
    validAfter: 0,
    validBefore,
    nonce: nonce(),
  });

  return { syndicate_id: req.syndicate_id, deposit_auth, balance_auth, reverified: true };
}

// ── Coordinator side ─────────────────────────────────────────────────────

export interface StrikeResult {
  ok: boolean;
  settledCount: number;
  moq: number;
  reason?: string;
}

export class ThresholdSettlement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly executor: SettlementExecutor,
    private readonly opts: { reputation?: CommerceReputationSink } = {},
  ) {}

  /** Accept a member's signed commit. Rejects unless re-verification passed. */
  recordCommitment(
    syndicateId: string,
    memberId: string,
    body: CommitResponseBody,
    now: number = Math.floor(Date.now() / 1000),
  ): { ok: boolean; error?: string } {
    if (!body.reverified) {
      return { ok: false, error: "commit rejected: independent re-verification required (§7.2)" };
    }
    const member = this.db
      .prepare(`SELECT buyer_pubkey FROM group_buy_members WHERE id = ? AND syndicate_id = ?`)
      .get(memberId, syndicateId) as { buyer_pubkey: string } | undefined;
    if (!member) {
      return { ok: false, error: "unknown member" };
    }

    this.db
      .prepare(
        `UPDATE group_buy_members SET commit_status = 'committed', auth_token = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(body), now, memberId);

    this.insertSettlement(
      syndicateId,
      memberId,
      member.buyer_pubkey,
      body.deposit_auth,
      "deposit",
      now,
    );
    this.insertSettlement(
      syndicateId,
      memberId,
      member.buyer_pubkey,
      body.balance_auth,
      "balance",
      now,
    );
    return { ok: true };
  }

  /**
   * Strike the syndicate: confirm-then-capture. Aborts (capturing nothing) if
   * fewer than MOQ members have committed. Otherwise captures each deposit leg
   * and feeds the outcome into commerce reputation.
   */
  async strike(
    syndicateId: string,
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<StrikeResult> {
    const syn = this.db
      .prepare(`SELECT moq, status FROM group_buy_syndicates WHERE id = ?`)
      .get(syndicateId) as { moq: number; status: string } | undefined;
    if (!syn) {
      return { ok: false, settledCount: 0, moq: 0, reason: "unknown syndicate" };
    }

    const deposits = this.db
      .prepare(
        `SELECT s.id, s.member_id, s.amount_usdc, s.auth_token, m.buyer_pubkey
           FROM group_buy_settlements s
           JOIN group_buy_members m ON m.id = s.member_id
          WHERE s.syndicate_id = ? AND s.leg = 'deposit' AND s.status = 'authorized'
            AND m.commit_status = 'committed'`,
      )
      .all(syndicateId) as Array<{
      id: string;
      member_id: string;
      amount_usdc: number;
      auth_token: string;
      buyer_pubkey: string;
    }>;

    if (deposits.length < syn.moq) {
      return { ok: false, settledCount: 0, moq: syn.moq, reason: "under MOQ; nothing captured" };
    }

    this.setSyndicateStatus(syndicateId, "striking", now);

    let settledCount = 0;
    for (const dep of deposits) {
      const auth = JSON.parse(dep.auth_token) as Eip3009Authorization;
      try {
        const { txHash } = await this.executor.capture(auth);
        this.markSettlement(dep.id, "settled", now, txHash);
        this.setMemberStatus(dep.member_id, "settled", now);
        this.opts.reputation?.recordSettlementOutcome(
          dep.buyer_pubkey,
          "buyer",
          "settled",
          dep.amount_usdc,
        );
        settledCount += 1;
      } catch (err) {
        this.markSettlement(dep.id, "failed", now, undefined, String(err));
        this.setMemberStatus(dep.member_id, "failed", now);
        this.opts.reputation?.recordSettlementOutcome(
          dep.buyer_pubkey,
          "buyer",
          "defaulted",
          dep.amount_usdc,
        );
      }
    }

    const ok = settledCount >= syn.moq;
    this.setSyndicateStatus(syndicateId, ok ? "settled" : "failed", now);
    return { ok, settledCount, moq: syn.moq };
  }

  private insertSettlement(
    syndicateId: string,
    memberId: string,
    buyerPubkey: string,
    auth: Eip3009Authorization,
    leg: "deposit" | "balance",
    now: number,
  ): void {
    const id = crypto.createHash("sha256").update(`${memberId}|${leg}`).digest("hex").slice(0, 32);
    const amountUsdc = Number(BigInt(auth.value)) / 1e6;
    this.db
      .prepare(
        `INSERT INTO group_buy_settlements
           (id, syndicate_id, member_id, buyer_pubkey, supplier_address, amount_usdc, leg,
            auth_token, status, created_at)
         VALUES (?,?,?,?,?,?,?,?, 'authorized', ?)
         ON CONFLICT(id) DO UPDATE SET auth_token = excluded.auth_token, status = 'authorized'`,
      )
      .run(
        id,
        syndicateId,
        memberId,
        buyerPubkey,
        auth.to,
        amountUsdc,
        leg,
        JSON.stringify(auth),
        now,
      );
  }

  private markSettlement(
    id: string,
    status: string,
    now: number,
    txHash?: string,
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE group_buy_settlements SET status = ?, tx_hash = ?, error = ?, settled_at = ? WHERE id = ?`,
      )
      .run(status, txHash ?? null, error ?? null, status === "settled" ? now : null, id);
  }

  private setMemberStatus(memberId: string, status: string, now: number): void {
    this.db
      .prepare(`UPDATE group_buy_members SET commit_status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, memberId);
  }

  private setSyndicateStatus(syndicateId: string, status: string, now: number): void {
    this.db
      .prepare(`UPDATE group_buy_syndicates SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, syndicateId);
  }
}
