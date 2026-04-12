/**
 * Marketplace Economics Manager
 *
 * Handles the economic layer of the skill marketplace:
 * 1. Determine which skills qualify for paid listing (quality gates)
 * 2. Compute and cache prices via the pricing engine
 * 3. Track purchases (buyer peer, amount, tx hash, direction)
 * 4. Feed economic data into The Niche (via getEconomicSummary())
 * 5. Provide pricing info for Agent Card + A2A payment gate
 *
 * This complements SkillMarketplace (skill-marketplace.ts) which handles
 * search, discovery, trending, and recommendations.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { computeSkillPrice, type SkillPricingConfig } from "./skill-pricing.js";

const log = createSubsystemLogger("memory/marketplace-economics");

export interface MarketplaceListing {
  skillCrystalId: string;
  name: string;
  description: string;
  priceUsdc: number;
  listable: boolean;
  metrics: {
    totalExecutions: number;
    successRate: number;
    avgRewardScore: number;
  };
  downloadCount: number;
  listedAt: number | null;
}

export interface PurchaseRecord {
  id: string;
  skillCrystalId: string;
  buyerPeerId: string;
  amountUsdc: number;
  txHash?: string;
  direction: "sale" | "purchase";
  purchasedAt: number;
}

export interface EconomicSummary {
  /** Total USDC earned from skill sales */
  totalEarningsUsdc: number;
  /** Total USDC spent purchasing skills */
  totalSpentUsdc: number;
  /** Net earnings (earned - spent) */
  netEarningsUsdc: number;
  /** Number of skills currently listed */
  listedSkillCount: number;
  /** Number of unique buyers */
  uniqueBuyers: number;
  /** Number of skills purchased from others */
  skillsPurchased: number;
  /** Top earning skills */
  topEarners: Array<{ name: string; earningsUsdc: number; purchases: number }>;
  /** Earnings trend (last 7 days daily totals) */
  earningsTrend: Array<{ date: string; amountUsdc: number }>;
  /** Current wallet balance (USDC) */
  walletBalanceUsdc?: number;
}

export class MarketplaceEconomics {
  private onSaleCallback:
    | ((params: { skillCrystalId: string; amountUsdc: number; txHash?: string }) => void)
    | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly pricingConfig?: Partial<SkillPricingConfig>,
  ) {
    this.ensureSchema();
  }

  /** Expose the underlying DB for cross-module queries (e.g., x402 replay protection). */
  getDb(): DatabaseSync {
    return this.db;
  }

  /** Register a callback for sale events (e.g., to notify wallet UI). */
  onSale(
    callback: (params: { skillCrystalId: string; amountUsdc: number; txHash?: string }) => void,
  ): void {
    this.onSaleCallback = callback;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS marketplace_listings (
        skill_crystal_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price_usdc REAL NOT NULL,
        listable INTEGER NOT NULL DEFAULT 0,
        listing_block_reason TEXT,
        total_executions INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0,
        avg_reward_score REAL DEFAULT 0,
        download_count INTEGER DEFAULT 0,
        bounty_matches INTEGER DEFAULT 0,
        listed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS marketplace_purchases (
        id TEXT PRIMARY KEY,
        skill_crystal_id TEXT NOT NULL,
        buyer_peer_id TEXT NOT NULL,
        amount_usdc REAL NOT NULL,
        tx_hash TEXT,
        direction TEXT NOT NULL DEFAULT 'sale',
        purchased_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mp_purchases_crystal ON marketplace_purchases(skill_crystal_id);
      CREATE INDEX IF NOT EXISTS idx_mp_purchases_date ON marketplace_purchases(purchased_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_purchases_tx_hash ON marketplace_purchases(tx_hash)
        WHERE tx_hash IS NOT NULL;

      -- Plan 8, Phase 1: Revenue payment queue with 48h dispute window
      CREATE TABLE IF NOT EXISTS revenue_payment_queue (
        id TEXT PRIMARY KEY,
        skill_crystal_id TEXT NOT NULL,
        purchase_id TEXT NOT NULL,
        recipient_peer_id TEXT NOT NULL,
        amount_usdc REAL NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'held',
        dispute_reason TEXT,
        tx_hash TEXT,
        error TEXT,
        queued_at INTEGER NOT NULL,
        release_at INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_rpq_status ON revenue_payment_queue(status);
    `);
  }

  /**
   * Refresh marketplace listings by scanning all published skill crystals.
   * Called during consolidation (every 30 min) — not on every request.
   *
   * All writes are wrapped in a single transaction to avoid blocking the
   * Node.js event loop during consolidation. (Gemini peer review: SQLite I/O choke fix)
   */
  refreshListings(reputationScore: number): number {
    // Get all published skill/task_pattern crystals
    const skills = this.db
      .prepare(`
      SELECT c.id, c.text, c.semantic_type,
             COALESCE(c.download_count, 0) as download_count,
             c.skill_category
      FROM chunks c
      WHERE c.publish_visibility = 'shared'
        AND c.semantic_type IN ('skill', 'task_pattern')
        AND COALESCE(c.lifecycle_state, 'active') != 'archived'
    `)
      .all() as Array<{
      id: string;
      text: string;
      semantic_type: string;
      download_count: number;
      skill_category: string | null;
    }>;

    let listedCount = 0;
    const now = Date.now();

    this.db.exec("BEGIN");
    try {
      for (const skill of skills) {
        const metrics = this.getSkillMetrics(skill.id);

        // Use unique buyer count, not raw download count.
        // Raw count is trivially gameable via sybil wash trading.
        // (Gemini peer review fix)
        const uniqueBuyers = this.getUniqueBuyerCount(skill.id);

        const pricing = computeSkillPrice(
          {
            metrics: {
              totalExecutions: metrics.totalExecutions,
              successRate: metrics.successRate,
              avgRewardScore: metrics.avgRewardScore,
            },
            downloadCount: uniqueBuyers,
            bountyMatches: this.countBountyMatches(skill.id),
            reputationScore,
            similarSkillCount: this.countSimilarSkills(skill.skill_category),
          },
          this.pricingConfig,
        );

        const name = skill.text.split("\n")[0]?.slice(0, 100).trim() || skill.id.slice(0, 8);
        this.db
          .prepare(`
          INSERT INTO marketplace_listings
            (skill_crystal_id, name, description, price_usdc, listable, listing_block_reason,
             total_executions, success_rate, avg_reward_score, download_count, bounty_matches,
             listed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(skill_crystal_id) DO UPDATE SET
            price_usdc = excluded.price_usdc,
            listable = excluded.listable,
            listing_block_reason = excluded.listing_block_reason,
            total_executions = excluded.total_executions,
            success_rate = excluded.success_rate,
            avg_reward_score = excluded.avg_reward_score,
            download_count = excluded.download_count,
            bounty_matches = excluded.bounty_matches,
            listed_at = CASE WHEN excluded.listable = 1 AND marketplace_listings.listed_at IS NULL
                        THEN excluded.updated_at ELSE marketplace_listings.listed_at END,
            updated_at = excluded.updated_at
        `)
          .run(
            skill.id,
            name,
            skill.text.slice(0, 500),
            pricing.priceUsdc,
            pricing.listable ? 1 : 0,
            pricing.listingBlockReason ?? null,
            metrics.totalExecutions,
            metrics.successRate,
            metrics.avgRewardScore,
            skill.download_count,
            0,
            pricing.listable ? now : null,
            now,
          );

        if (pricing.listable) listedCount++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      log.warn(`Marketplace listing refresh failed: ${String(err)}`);
    }

    return listedCount;
  }

  /**
   * Record a skill purchase (incoming sale or outgoing purchase).
   * Returns the purchase ID.
   */
  recordPurchase(params: {
    skillCrystalId: string;
    buyerPeerId: string;
    amountUsdc: number;
    txHash?: string;
    direction: "sale" | "purchase";
  }): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(`
      INSERT INTO marketplace_purchases
        (id, skill_crystal_id, buyer_peer_id, amount_usdc, tx_hash, direction, purchased_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        params.skillCrystalId,
        params.buyerPeerId,
        params.amountUsdc,
        params.txHash ?? null,
        params.direction,
        Date.now(),
      );

    // Notify listeners (e.g., wallet UI) of incoming sales
    if (params.direction === "sale" && this.onSaleCallback) {
      try {
        this.onSaleCallback({
          skillCrystalId: params.skillCrystalId,
          amountUsdc: params.amountUsdc,
          txHash: params.txHash,
        });
      } catch {
        /* non-critical */
      }
    }

    return id;
  }

  /**
   * Compute revenue split for a skill purchase based on provenance lineage.
   * 70% to current publisher, 20% to original author, 10% to mutation contributors.
   */
  computeRevenueShares(
    skillCrystalId: string,
    totalUsdc: number,
  ): Array<{
    role: "publisher" | "original_author" | "contributor";
    peerId: string;
    amountUsdc: number;
  }> {
    try {
      const chunk = this.db
        .prepare(`SELECT provenance_chain, origin FROM chunks WHERE id = ?`)
        .get(skillCrystalId) as
        | { provenance_chain: string | null; origin: string | null }
        | undefined;

      if (!chunk?.provenance_chain) {
        return [{ role: "publisher", peerId: "local", amountUsdc: totalUsdc }];
      }

      const chain: string[] = JSON.parse(chunk.provenance_chain);
      if (chain.length === 0) {
        return [{ role: "publisher", peerId: "local", amountUsdc: totalUsdc }];
      }

      const shares: Array<{
        role: "publisher" | "original_author" | "contributor";
        peerId: string;
        amountUsdc: number;
      }> = [];

      // 70% to current publisher (local node)
      shares.push({ role: "publisher", peerId: "local", amountUsdc: totalUsdc * 0.7 });

      // 20% to original author (first in chain)
      const originalAuthor = chain[0] ?? "unknown";
      shares.push({ role: "original_author", peerId: originalAuthor, amountUsdc: totalUsdc * 0.2 });

      // 10% split among mutation contributors (rest of chain)
      const contributors = chain.slice(1);
      if (contributors.length > 0) {
        const perContributor = (totalUsdc * 0.1) / contributors.length;
        for (const c of contributors) {
          shares.push({ role: "contributor", peerId: c, amountUsdc: perContributor });
        }
      } else {
        // No contributors — publisher gets the 10% too
        shares[0]!.amountUsdc += totalUsdc * 0.1;
      }

      return shares;
    } catch {
      return [{ role: "publisher", peerId: "local", amountUsdc: totalUsdc }];
    }
  }

  /**
   * Check if a tx_hash has already been used (replay protection).
   */
  isTxHashConsumed(txHash: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM marketplace_purchases WHERE tx_hash = ?`)
      .get(txHash);
    return !!row;
  }

  /**
   * Get economic summary for The Niche section of working memory.
   */
  getEconomicSummary(): EconomicSummary {
    const sales = this.db
      .prepare(`
      SELECT COALESCE(SUM(amount_usdc), 0) as total,
             COUNT(DISTINCT buyer_peer_id) as buyers,
             COUNT(*) as count
      FROM marketplace_purchases WHERE direction = 'sale'
    `)
      .get() as { total: number; buyers: number; count: number };

    const purchases = this.db
      .prepare(`
      SELECT COALESCE(SUM(amount_usdc), 0) as total, COUNT(*) as count
      FROM marketplace_purchases WHERE direction = 'purchase'
    `)
      .get() as { total: number; count: number };

    const listed = this.db
      .prepare(`
      SELECT COUNT(*) as c FROM marketplace_listings WHERE listable = 1
    `)
      .get() as { c: number };

    const topEarners = this.db
      .prepare(`
      SELECT ml.name, SUM(mp.amount_usdc) as earnings, COUNT(*) as purchases
      FROM marketplace_purchases mp
      JOIN marketplace_listings ml ON ml.skill_crystal_id = mp.skill_crystal_id
      WHERE mp.direction = 'sale'
      GROUP BY mp.skill_crystal_id
      ORDER BY earnings DESC
      LIMIT 5
    `)
      .all() as Array<{ name: string; earnings: number; purchases: number }>;

    // Earnings trend (last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const dailyEarnings = this.db
      .prepare(`
      SELECT date(purchased_at / 1000, 'unixepoch') as date,
             SUM(amount_usdc) as amount
      FROM marketplace_purchases
      WHERE direction = 'sale' AND purchased_at >= ?
      GROUP BY date
      ORDER BY date
    `)
      .all(sevenDaysAgo) as Array<{ date: string; amount: number }>;

    return {
      totalEarningsUsdc: sales.total,
      totalSpentUsdc: purchases.total,
      netEarningsUsdc: sales.total - purchases.total,
      listedSkillCount: listed.c,
      uniqueBuyers: sales.buyers,
      skillsPurchased: purchases.count,
      topEarners: topEarners.map((e) => ({
        name: e.name,
        earningsUsdc: e.earnings,
        purchases: e.purchases,
      })),
      earningsTrend: dailyEarnings.map((d) => ({
        date: d.date,
        amountUsdc: d.amount,
      })),
    };
  }

  /**
   * Get recent sales count and amount since a given timestamp.
   * Used for earnings notifications.
   */
  getRecentSales(sinceMs: number): { count: number; totalUsdc: number } {
    const row = this.db
      .prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(amount_usdc), 0) as total
      FROM marketplace_purchases
      WHERE direction = 'sale' AND purchased_at >= ?
    `)
      .get(sinceMs) as { count: number; total: number };
    return { count: row.count, totalUsdc: row.total };
  }

  /**
   * Get the listed price for a specific skill (used by A2A payment gate).
   */
  getSkillPrice(skillCrystalId: string): number | null {
    const row = this.db
      .prepare(`
      SELECT price_usdc FROM marketplace_listings
      WHERE skill_crystal_id = ? AND listable = 1
    `)
      .get(skillCrystalId) as { price_usdc: number } | undefined;
    return row?.price_usdc ?? null;
  }

  /**
   * Get all listable skills for Agent Card generation.
   */
  getListableSkills(): MarketplaceListing[] {
    const rows = this.db
      .prepare(`
      SELECT skill_crystal_id, name, description, price_usdc, listable,
             total_executions, success_rate, avg_reward_score, download_count, listed_at
      FROM marketplace_listings WHERE listable = 1 ORDER BY price_usdc DESC
    `)
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      skillCrystalId: String(r.skill_crystal_id),
      name: String(r.name),
      description: String(r.description ?? ""),
      priceUsdc: Number(r.price_usdc),
      listable: true,
      metrics: {
        totalExecutions: Number(r.total_executions),
        successRate: Number(r.success_rate),
        avgRewardScore: Number(r.avg_reward_score),
      },
      downloadCount: Number(r.download_count),
      listedAt: r.listed_at ? Number(r.listed_at) : null,
    }));
  }

  /**
   * Count unique buyers for a skill (anti-sybil: distinct peer IDs only).
   */
  /** Count active bounties that this skill could fulfill. */
  private countBountyMatches(skillCrystalId: string): number {
    try {
      const row = this.db
        .prepare(`
        SELECT COUNT(*) as c FROM curiosity_targets
        WHERE resolved_at IS NULL AND expires_at > ?
          AND metadata LIKE '%"isBounty":true%'
      `)
        .get(Date.now()) as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  /** Count similar skills on the network for scarcity pricing. */
  private countSimilarSkills(category: string | null): number {
    if (!category) return 5; // Default fallback
    try {
      const row = this.db
        .prepare(`
        SELECT COUNT(*) as c FROM chunks
        WHERE skill_category = ?
          AND COALESCE(lifecycle_state, 'active') != 'archived'
          AND COALESCE(deprecated, 0) != 1
      `)
        .get(category) as { c: number } | undefined;
      return row?.c ?? 5;
    } catch {
      return 5;
    }
  }

  private getUniqueBuyerCount(skillCrystalId: string): number {
    const row = this.db
      .prepare(`
      SELECT COUNT(DISTINCT buyer_peer_id) as c
      FROM marketplace_purchases
      WHERE skill_crystal_id = ? AND direction = 'sale'
    `)
      .get(skillCrystalId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  private getSkillMetrics(skillCrystalId: string): {
    totalExecutions: number;
    successRate: number;
    avgRewardScore: number;
  } {
    try {
      const row = this.db
        .prepare(`
        SELECT COUNT(*) as total,
               COALESCE(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END), 0) as success_rate,
               COALESCE(AVG(reward_score), 0) as avg_reward
        FROM skill_executions
        WHERE skill_crystal_id = ? AND completed_at IS NOT NULL
      `)
        .get(skillCrystalId) as { total: number; success_rate: number; avg_reward: number };

      return {
        totalExecutions: row?.total ?? 0,
        successRate: row?.success_rate ?? 0,
        avgRewardScore: row?.avg_reward ?? 0,
      };
    } catch {
      // skill_executions table may not exist yet
      return { totalExecutions: 0, successRate: 0, avgRewardScore: 0 };
    }
  }

  // ── Plan 8, Phase 1: Revenue Payment Queue with 48h Dispute Window ──

  private static readonly HOLD_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours
  private static readonly DUST_THRESHOLD_USDC = 0.001;

  /** Queue a revenue payment with 48h hold before release. */
  queueRevenuePayment(params: {
    skillCrystalId: string;
    purchaseId: string;
    recipientPeerId: string;
    amountUsdc: number;
    role: string;
  }): void {
    if (params.amountUsdc < MarketplaceEconomics.DUST_THRESHOLD_USDC) return;
    const now = Date.now();
    this.db
      .prepare(`
      INSERT INTO revenue_payment_queue
        (id, skill_crystal_id, purchase_id, recipient_peer_id, amount_usdc, role, status, queued_at, release_at)
      VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?)
    `)
      .run(
        crypto.randomUUID(),
        params.skillCrystalId,
        params.purchaseId,
        params.recipientPeerId,
        params.amountUsdc,
        params.role,
        now,
        now + MarketplaceEconomics.HOLD_DURATION_MS,
      );
  }

  /** Transition held payments past the 48h window to released (if no dispute). */
  releaseHeldPayments(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE revenue_payment_queue SET status = 'released' WHERE status = 'held' AND release_at <= ?`,
      )
      .run(now);
    return Number(result.changes);
  }

  /** Get payments that are released and ready for dispatch. */
  getReleasedPayments(): Array<{
    id: string;
    recipientPeerId: string;
    amountUsdc: number;
    role: string;
    skillCrystalId: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, recipient_peer_id as recipientPeerId, amount_usdc as amountUsdc, role, skill_crystal_id as skillCrystalId
       FROM revenue_payment_queue WHERE status = 'released'`,
      )
      .all() as Array<{
      id: string;
      recipientPeerId: string;
      amountUsdc: number;
      role: string;
      skillCrystalId: string;
    }>;
  }

  /** Dispute a payment (buyer can call within 48h hold window). */
  disputePayment(purchaseId: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE revenue_payment_queue SET status = 'disputed', dispute_reason = ?
       WHERE purchase_id = ? AND status = 'held'`,
      )
      .run(reason, purchaseId);
    return result.changes > 0;
  }

  /** Mark a payment as dispatched onchain. */
  markPaymentProcessed(id: string, txHash: string): void {
    this.db
      .prepare(
        `UPDATE revenue_payment_queue SET status = 'paid', tx_hash = ?, processed_at = ? WHERE id = ?`,
      )
      .run(txHash, Date.now(), id);
  }

  /** Mark a payment as failed (will retry on next consolidation). */
  markPaymentFailed(id: string, error: string): void {
    this.db
      .prepare(`UPDATE revenue_payment_queue SET status = 'released', error = ? WHERE id = ?`)
      .run(error, id);
  }

  /** Resolve a peer's wallet address from the reputation table. */
  resolvePeerWalletAddress(peerPubkey: string): string | null {
    try {
      const row = this.db
        .prepare(`SELECT wallet_address FROM peer_reputation WHERE peer_pubkey = ?`)
        .get(peerPubkey) as { wallet_address: string | null } | undefined;
      return row?.wallet_address ?? null;
    } catch {
      return null;
    }
  }

  /** Get revenue queue stats for observability. */
  getRevenueQueueStats(): {
    held: number;
    released: number;
    paid: number;
    disputed: number;
    failed: number;
  } {
    try {
      const rows = this.db
        .prepare(`SELECT status, COUNT(*) as c FROM revenue_payment_queue GROUP BY status`)
        .all() as Array<{ status: string; c: number }>;
      const map = new Map(rows.map((r) => [r.status, r.c]));
      return {
        held: map.get("held") ?? 0,
        released: map.get("released") ?? 0,
        paid: map.get("paid") ?? 0,
        disputed: map.get("disputed") ?? 0,
        failed: rows.filter((r) => r.status === "released" && r.c > 0).length, // approximation
      };
    } catch {
      return { held: 0, released: 0, paid: 0, disputed: 0, failed: 0 };
    }
  }
}
