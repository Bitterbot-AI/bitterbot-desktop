/**
 * SkillMarketplace: discovery, search, ranking, and recommendations for skills.
 *
 * Combines execution metrics, peer reputation, multi-perspective search,
 * and divergence detection for a complete skill marketplace experience.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MarketplaceEntry, MarketplaceFilters } from "./crystal-types.js";
import type { PeerReputationManager } from "./peer-reputation.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/skill-marketplace");

/** Escape SQL LIKE wildcards so user input is treated literally. */
function escapeLike(str: string): string {
  return str.replace(/[%_\\]/g, "\\$&");
}

export type SkillDetail = MarketplaceEntry & {
  text: string;
  versionHistory: Array<{ version: number; crystalId: string; createdAt: number }>;
  executionMetrics: {
    totalExecutions: number;
    successRate: number;
    avgRewardScore: number;
  };
};

export class SkillMarketplace {
  private readonly db: DatabaseSync;
  private readonly executionTracker: SkillExecutionTracker;
  private readonly reputationManager: PeerReputationManager;

  constructor(
    db: DatabaseSync,
    executionTracker: SkillExecutionTracker,
    reputationManager: PeerReputationManager,
  ) {
    this.db = db;
    this.executionTracker = executionTracker;
    this.reputationManager = reputationManager;
  }

  /**
   * List a skill on the marketplace.
   */
  listSkill(crystalId: string, description?: string): boolean {
    const row = this.db
      .prepare(`SELECT id, stable_skill_id FROM chunks WHERE id = ?`)
      .get(crystalId) as { id: string; stable_skill_id: string | null } | undefined;

    if (!row) {
      return false;
    }

    this.db
      .prepare(`UPDATE chunks SET marketplace_listed = 1, marketplace_description = ? WHERE id = ?`)
      .run(description ?? null, crystalId);

    return true;
  }

  /**
   * Delist a skill from the marketplace.
   */
  delistSkill(crystalId: string): boolean {
    const result = this.db
      .prepare(`UPDATE chunks SET marketplace_listed = 0 WHERE id = ?`)
      .run(crystalId);
    return (result as { changes: number }).changes > 0;
  }

  /**
   * Search marketplace skills with filtering and sorting.
   */
  search(query: string, filters?: MarketplaceFilters): MarketplaceEntry[] {
    let sql = `
      SELECT id, text, stable_skill_id, skill_version, skill_tags, skill_category,
             governance_json, importance_score, download_count, created_at,
             marketplace_description, steering_reward, is_verified, verified_by
      FROM chunks
      WHERE marketplace_listed = 1
        AND COALESCE(deprecated, 0) = 0
        AND COALESCE(lifecycle, 'generated') != 'expired'
    `;
    const params: (string | number)[] = [];

    if (filters?.category) {
      sql += ` AND skill_category = ?`;
      params.push(filters.category);
    }
    if (filters?.tags?.length) {
      for (const tag of filters.tags) {
        sql += ` AND skill_tags LIKE ? ESCAPE '\\'`;
        params.push(`%"${escapeLike(tag)}"%`);
      }
    }

    // Text search via LIKE (basic; for production, use FTS)
    if (query) {
      sql += ` AND (text LIKE ? ESCAPE '\\' OR marketplace_description LIKE ? ESCAPE '\\')`;
      const pattern = `%${escapeLike(query)}%`;
      params.push(pattern, pattern);
    }

    // Sort
    const sortBy = filters?.sortBy ?? "relevance";
    switch (sortBy) {
      case "trending":
        sql += ` ORDER BY download_count DESC, created_at DESC`;
        break;
      case "newest":
        sql += ` ORDER BY created_at DESC`;
        break;
      case "top_rated":
        sql += ` ORDER BY COALESCE(steering_reward, 0) DESC, importance_score DESC`;
        break;
      default:
        sql += ` ORDER BY COALESCE(is_verified, 0) DESC, importance_score DESC`;
    }

    sql += ` LIMIT 50`;

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return this.rowsToEntries(rows, filters);
  }

  /**
   * Get trending skills (most downloaded + highest rated in last 7 days).
   */
  getTrending(limit = 10): MarketplaceEntry[] {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT id, text, stable_skill_id, skill_version, skill_tags, skill_category,
                governance_json, importance_score, download_count, created_at,
                marketplace_description, steering_reward
         FROM chunks
         WHERE marketplace_listed = 1
           AND COALESCE(deprecated, 0) = 0
           AND created_at >= ?
         ORDER BY download_count DESC, COALESCE(steering_reward, 0) DESC
         LIMIT ?`,
      )
      .all(weekAgo, limit) as Array<Record<string, unknown>>;

    return this.rowsToEntries(rows);
  }

  /**
   * Get recommended skills based on user's existing skill gaps.
   */
  getRecommendations(limit = 10): MarketplaceEntry[] {
    // Find skills the user doesn't have: marketplace listed, from peers, not already local
    const rows = this.db
      .prepare(
        `SELECT id, text, stable_skill_id, skill_version, skill_tags, skill_category,
                governance_json, importance_score, download_count, created_at,
                marketplace_description, steering_reward
         FROM chunks
         WHERE marketplace_listed = 1
           AND COALESCE(deprecated, 0) = 0
           AND governance_json LIKE '%peerOrigin%'
         ORDER BY importance_score DESC, COALESCE(steering_reward, 0) DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return this.rowsToEntries(rows);
  }

  /**
   * Get detailed information about a skill by stable_skill_id.
   */
  getSkillDetail(stableSkillId: string): SkillDetail | null {
    // Get latest version
    const row = this.db
      .prepare(
        `SELECT id, text, stable_skill_id, skill_version, skill_tags, skill_category,
                governance_json, importance_score, download_count, created_at,
                marketplace_description, steering_reward
         FROM chunks
         WHERE stable_skill_id = ?
           AND COALESCE(deprecated, 0) = 0
         ORDER BY skill_version DESC
         LIMIT 1`,
      )
      .get(stableSkillId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const entry = this.rowToEntry(row);

    // Version history
    const versions = this.db
      .prepare(
        `SELECT skill_version, id, created_at FROM chunks
         WHERE stable_skill_id = ?
         ORDER BY skill_version ASC`,
      )
      .all(stableSkillId) as Array<{
      skill_version: number;
      id: string;
      created_at: number;
    }>;

    // Execution metrics
    const metrics = this.executionTracker.getSkillMetrics(String(row.id));

    return {
      ...entry,
      text: String(row.text ?? ""),
      versionHistory: versions.map((v) => ({
        version: v.skill_version,
        crystalId: v.id,
        createdAt: v.created_at,
      })),
      executionMetrics: {
        totalExecutions: metrics.totalExecutions,
        successRate: metrics.successRate,
        avgRewardScore: metrics.avgRewardScore,
      },
    };
  }

  /**
   * Record a download/use of a skill.
   */
  recordDownload(crystalId: string): void {
    this.db
      .prepare(`UPDATE chunks SET download_count = COALESCE(download_count, 0) + 1 WHERE id = ?`)
      .run(crystalId);
  }

  private rowsToEntries(
    rows: Array<Record<string, unknown>>,
    filters?: MarketplaceFilters,
  ): MarketplaceEntry[] {
    // Pre-compute reputation cache to avoid redundant queries for the same peer
    const reputationCache = new Map<string, { reputationScore: number } | null>();
    for (const row of rows) {
      let governance: Record<string, unknown> = {};
      try {
        if (row.governance_json) {
          governance = JSON.parse(String(row.governance_json));
        }
      } catch {}
      const pubkey = String(governance.peerOrigin ?? "");
      if (pubkey && !reputationCache.has(pubkey)) {
        reputationCache.set(pubkey, this.reputationManager.getReputation(pubkey));
      }
    }

    let entries = rows.map((r) => this.rowToEntry(r, reputationCache));

    if (filters?.minSuccessRate != null) {
      entries = entries.filter((e) => e.successRate >= (filters.minSuccessRate ?? 0));
    }
    if (filters?.minAuthorReputation != null) {
      entries = entries.filter((e) => e.authorReputation >= (filters.minAuthorReputation ?? 0));
    }

    return entries;
  }

  private rowToEntry(
    row: Record<string, unknown>,
    reputationCache?: Map<string, { reputationScore: number } | null>,
  ): MarketplaceEntry {
    let governance: Record<string, unknown> = {};
    try {
      if (row.governance_json) {
        governance = JSON.parse(String(row.governance_json));
      }
    } catch {
      log.debug(`rowToEntry: corrupted governance_json for crystal ${String(row.id)}`);
    }

    const peerPubkey = String(governance.peerOrigin ?? "");
    const rep = peerPubkey
      ? (reputationCache?.get(peerPubkey) ?? this.reputationManager.getReputation(peerPubkey))
      : null;

    let tags: string[] = [];
    try {
      if (row.skill_tags) {
        tags = JSON.parse(String(row.skill_tags));
      }
    } catch {
      log.debug(`rowToEntry: corrupted skill_tags JSON for crystal ${String(row.id)}`);
    }

    const metrics = this.executionTracker.getSkillMetrics(String(row.id));

    return {
      stableSkillId: String(row.stable_skill_id ?? row.id ?? ""),
      name: String(row.marketplace_description ?? row.skill_category ?? "Skill"),
      description: String(row.marketplace_description ?? String(row.text ?? "").slice(0, 200)),
      version: Number(row.skill_version ?? 1),
      authorPeerId: peerPubkey,
      authorReputation: rep?.reputationScore ?? 0.5,
      successRate: metrics.successRate,
      downloadCount: Number(row.download_count ?? 0),
      tags,
      category: String(row.skill_category ?? "general"),
      createdAt: Number(row.created_at ?? 0),
      isVerified: row.is_verified === 1,
      verifiedBy: row.verified_by ? String(row.verified_by) : null,
    };
  }
}
