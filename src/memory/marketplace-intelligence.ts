/**
 * Marketplace Intelligence — demand-driven dream targeting.
 *
 * Analyzes market demand signals (purchases, bounties, searches) and
 * identifies opportunities for the dream engine to explore.
 *
 * Closed loop: Market demand → Dream targets → Skill creation → Sales → Updated demand.
 *
 * Plan 8, Phase 7.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { DreamMode } from "./dream-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/marketplace-intelligence");

export interface MarketOpportunity {
  category: string;
  demandScore: number;
  readinessScore: number;
  expectedRevenueUsdc: number;
  targetDescription: string;
}

export class MarketplaceIntelligence {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Check if the marketplace has had any activity in the last 7 days.
   * Used to gate dream mode weight allocation — no activity = no market signal.
   */
  hasActivity(): boolean {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    try {
      const purchases =
        (
          this.db
            .prepare(`SELECT COUNT(*) as c FROM marketplace_purchases WHERE purchased_at > ?`)
            .get(weekAgo) as { c: number } | undefined
        )?.c ?? 0;

      const listings =
        (
          this.db
            .prepare(`SELECT COUNT(*) as c FROM marketplace_listings WHERE listed_at > ?`)
            .get(weekAgo) as { c: number } | undefined
        )?.c ?? 0;

      let bounties = 0;
      try {
        bounties =
          (
            this.db
              .prepare(
                `SELECT COUNT(*) as c FROM curiosity_targets
               WHERE metadata LIKE '%"isBounty":true%' AND expires_at > ?`,
              )
              .get(Date.now()) as { c: number } | undefined
          )?.c ?? 0;
      } catch {
        // curiosity_targets table may not exist
      }

      return purchases + listings + bounties > 0;
    } catch {
      return false;
    }
  }

  /**
   * Identify the top market opportunities for dream targeting.
   *
   * Demand signals:
   * - Recent purchases by category (last 7 days)
   * - Active bounties by target_type
   * - Unfulfilled search queries (low-score hits)
   *
   * Readiness signals:
   * - Execution success rate in category
   * - Existing skill count in category
   */
  analyzeOpportunities(limit: number = 5): MarketOpportunity[] {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const opportunities = new Map<string, { demand: number; readiness: number; revenue: number }>();

    try {
      // 1. Purchase frequency by skill_category
      const purchaseRows = this.db
        .prepare(
          `SELECT c.skill_category as category, COUNT(*) as purchases, AVG(mp.amount_usdc) as avg_price
           FROM marketplace_purchases mp
           JOIN chunks c ON c.id = mp.skill_crystal_id
           WHERE mp.purchased_at > ? AND c.skill_category IS NOT NULL
           GROUP BY c.skill_category
           ORDER BY purchases DESC LIMIT 10`,
        )
        .all(weekAgo) as Array<{
        category: string;
        purchases: number;
        avg_price: number;
      }>;

      for (const row of purchaseRows) {
        const demand = Math.min(1, row.purchases / 10); // 10 purchases = max demand
        const revenue = row.avg_price * row.purchases;
        opportunities.set(row.category, {
          demand,
          readiness: 0,
          revenue,
        });
      }

      // 2. Active bounties contribute to demand
      try {
        const bountyRows = this.db
          .prepare(
            `SELECT metadata FROM curiosity_targets
             WHERE metadata LIKE '%"isBounty":true%'
               AND resolved_at IS NULL AND expires_at > ?`,
          )
          .all(Date.now()) as Array<{ metadata: string }>;

        for (const row of bountyRows) {
          try {
            const meta = JSON.parse(row.metadata);
            const category = meta.category ?? meta.target_type ?? "general";
            const existing = opportunities.get(category) ?? { demand: 0, readiness: 0, revenue: 0 };
            existing.demand = Math.min(1, existing.demand + 0.2); // Each bounty adds 0.2
            existing.revenue += meta.rewardUsdc ?? 0;
            opportunities.set(category, existing);
          } catch {
            // Invalid metadata — skip
          }
        }
      } catch {
        // curiosity_targets may not exist
      }

      // 3. Readiness: how close are we to crystallizing in each category?
      for (const [category, opp] of opportunities) {
        try {
          const execRow = this.db
            .prepare(
              `SELECT COUNT(*) as total,
                      AVG(CASE WHEN se.success = 1 THEN 1.0 ELSE 0.0 END) as success_rate
               FROM skill_executions se
               JOIN chunks c ON c.id = se.skill_crystal_id
               WHERE c.skill_category = ? AND se.completed_at IS NOT NULL`,
            )
            .get(category) as { total: number; success_rate: number } | undefined;

          if (execRow && execRow.total >= 2) {
            opp.readiness = Math.min(1, (execRow.success_rate ?? 0) * (execRow.total / 5));
          }
        } catch {
          // Non-critical
        }
      }
    } catch {
      // Tables may not exist — return empty
    }

    // Convert to sorted array
    return [...opportunities.entries()]
      .map(([category, opp]) => ({
        category,
        demandScore: opp.demand,
        readinessScore: opp.readiness,
        expectedRevenueUsdc: opp.revenue,
        targetDescription: `High demand for ${category} skills (demand: ${opp.demand.toFixed(2)}, readiness: ${opp.readiness.toFixed(2)})`,
      }))
      .sort((a, b) => b.demandScore - a.demandScore)
      .slice(0, limit);
  }

  /**
   * Convert opportunities into dream mode weight adjustments.
   * High-opportunity categories boost exploration + mutation modes.
   * Returns empty object when no marketplace activity (weight fallback).
   */
  getDreamModeAdjustments(): Partial<Record<DreamMode, number>> {
    if (!this.hasActivity()) return {};

    const opportunities = this.analyzeOpportunities(3);
    if (opportunities.length === 0) return {};

    const topDemand = opportunities[0]!.demandScore;
    return {
      exploration: topDemand * 0.1,
      mutation: topDemand * 0.05,
      research: topDemand * 0.05,
    };
  }

  /**
   * Generate exploration targets from market demand.
   * These become curiosity targets for the dream engine.
   */
  generateDemandTargets(): Array<{
    type: string;
    description: string;
    priority: number;
    category: string;
  }> {
    const opportunities = this.analyzeOpportunities(3);
    return opportunities
      .filter((opp) => opp.demandScore >= 0.3)
      .map((opp) => ({
        type: "market_demand",
        description: `Market demand: ${opp.category} skills (expected $${opp.expectedRevenueUsdc.toFixed(2)} USDC)`,
        priority: Math.min(0.9, 0.5 + opp.demandScore * 0.4),
        category: opp.category,
      }));
  }

  /**
   * Inject demand targets into the curiosity engine's target table.
   * Called during dream cycles.
   */
  injectDemandTargets(): number {
    const targets = this.generateDemandTargets();
    let injected = 0;

    for (const target of targets) {
      try {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO curiosity_targets
             (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            "market_demand",
            target.description,
            target.priority,
            null,
            JSON.stringify({ category: target.category, source: "marketplace_intelligence" }),
            Date.now(),
            null,
            Date.now() + 24 * 60 * 60 * 1000, // 24h TTL
          );
        injected++;
      } catch {
        // Duplicate or missing table — non-critical
      }
    }

    if (injected > 0) {
      log.debug("marketplace intelligence injected demand targets", { count: injected });
    }
    return injected;
  }
}
