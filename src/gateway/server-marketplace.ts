/**
 * Marketplace gateway methods: exposes SkillMarketplace functionality
 * as RPC endpoints accessible via the gateway protocol.
 */

import type { MarketplaceEntry, MarketplaceFilters } from "../memory/crystal-types.js";
import type { SkillMarketplace, SkillDetail } from "../memory/skill-marketplace.js";

export type MarketplaceRpcMethods = {
  "marketplace.search": {
    params: { query: string; filters?: MarketplaceFilters };
    result: MarketplaceEntry[];
  };
  "marketplace.trending": {
    params: { limit?: number };
    result: MarketplaceEntry[];
  };
  "marketplace.recommendations": {
    params: { limit?: number };
    result: MarketplaceEntry[];
  };
  "marketplace.detail": {
    params: { stableSkillId: string };
    result: SkillDetail | null;
  };
  "marketplace.list": {
    params: { crystalId: string; description?: string };
    result: { ok: boolean };
  };
};

/**
 * Create marketplace request handler.
 */
export function createMarketplaceHandler(marketplace: SkillMarketplace | null) {
  return {
    "marketplace.search"(params: {
      query: string;
      filters?: MarketplaceFilters;
    }): MarketplaceEntry[] {
      if (!marketplace) {
        return [];
      }
      return marketplace.search(params.query, params.filters);
    },

    "marketplace.trending"(params: { limit?: number }): MarketplaceEntry[] {
      if (!marketplace) {
        return [];
      }
      return marketplace.getTrending(params.limit);
    },

    "marketplace.recommendations"(params: { limit?: number }): MarketplaceEntry[] {
      if (!marketplace) {
        return [];
      }
      return marketplace.getRecommendations(params.limit);
    },

    "marketplace.detail"(params: { stableSkillId: string }): SkillDetail | null {
      if (!marketplace) {
        return null;
      }
      return marketplace.getSkillDetail(params.stableSkillId);
    },

    "marketplace.list"(params: { crystalId: string; description?: string }): { ok: boolean } {
      if (!marketplace) {
        return { ok: false };
      }
      return { ok: marketplace.listSkill(params.crystalId, params.description) };
    },
  };
}
