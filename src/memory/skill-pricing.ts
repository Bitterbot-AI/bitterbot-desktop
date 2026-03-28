/**
 * Skill Pricing Engine
 *
 * Computes dynamic USDC prices for skill crystals based on:
 * - Execution quality metrics (success rate, reward score)
 * - Demand signals (download count, bounty matches)
 * - Peer reputation of the publishing agent
 * - Skill scarcity (how many similar skills exist on the network)
 *
 * Prices are computed lazily (on Agent Card generation or A2A task receipt)
 * and cached on the crystal for the next consolidation window.
 */

export interface SkillPricingConfig {
  /** Base price in USDC for any skill. Default: 0.01 */
  basePriceUsdc: number;
  /** Minimum price floor. Default: 0.001 */
  minPriceUsdc: number;
  /** Maximum price cap. Default: 1.00 */
  maxPriceUsdc: number;
  /** Fixed price override — disables dynamic pricing. */
  fixedPriceUsdc?: number;
  /** Minimum executions before a skill can be listed. Default: 3 */
  minExecutionsForListing: number;
  /** Minimum success rate to be listed. Default: 0.6 */
  minSuccessRateForListing: number;
}

export const DEFAULT_PRICING_CONFIG: SkillPricingConfig = {
  basePriceUsdc: 0.01,
  minPriceUsdc: 0.001,
  maxPriceUsdc: 1.00,
  minExecutionsForListing: 3,
  minSuccessRateForListing: 0.6,
};

export interface SkillPricingInput {
  /** Execution metrics from SkillExecutionTracker */
  metrics: {
    totalExecutions: number;
    successRate: number;      // 0-1
    avgRewardScore: number;   // 0-1
  };
  /** Download/purchase count (unique buyers only — anti-sybil) */
  downloadCount: number;
  /** Number of bounty matches this skill has fulfilled */
  bountyMatches: number;
  /** Publishing agent's reputation score (0-1) */
  reputationScore: number;
  /** Number of similar skills on the network (from P2P gossip) */
  similarSkillCount: number;
}

export interface SkillPricingResult {
  /** Final price in USDC */
  priceUsdc: number;
  /** Whether the skill meets listing requirements */
  listable: boolean;
  /** Reason if not listable */
  listingBlockReason?: string;
  /** Price breakdown for diagnostics */
  breakdown: {
    basePrice: number;
    qualityMultiplier: number;
    demandMultiplier: number;
    reputationMultiplier: number;
    scarcityBonus: number;
  };
}

export function computeSkillPrice(
  input: SkillPricingInput,
  config?: Partial<SkillPricingConfig>,
): SkillPricingResult {
  const cfg = { ...DEFAULT_PRICING_CONFIG, ...config };

  // Fixed price override
  if (cfg.fixedPriceUsdc !== undefined) {
    return {
      priceUsdc: cfg.fixedPriceUsdc,
      listable: true,
      breakdown: {
        basePrice: cfg.fixedPriceUsdc,
        qualityMultiplier: 1,
        demandMultiplier: 1,
        reputationMultiplier: 1,
        scarcityBonus: 1,
      },
    };
  }

  // Listing requirements gate
  if (input.metrics.totalExecutions < cfg.minExecutionsForListing) {
    return {
      priceUsdc: 0,
      listable: false,
      listingBlockReason: `Needs ${cfg.minExecutionsForListing - input.metrics.totalExecutions} more executions`,
      breakdown: { basePrice: 0, qualityMultiplier: 0, demandMultiplier: 0, reputationMultiplier: 0, scarcityBonus: 0 },
    };
  }
  if (input.metrics.successRate < cfg.minSuccessRateForListing) {
    return {
      priceUsdc: 0,
      listable: false,
      listingBlockReason: `Success rate ${(input.metrics.successRate * 100).toFixed(0)}% below ${(cfg.minSuccessRateForListing * 100).toFixed(0)}% minimum`,
      breakdown: { basePrice: 0, qualityMultiplier: 0, demandMultiplier: 0, reputationMultiplier: 0, scarcityBonus: 0 },
    };
  }

  // Dynamic pricing components
  const qualityMultiplier = input.metrics.successRate * Math.max(0.1, input.metrics.avgRewardScore);
  const demandMultiplier = 1 + Math.log(input.downloadCount + input.bountyMatches + 1) * 0.1;
  const reputationMultiplier = Math.max(0.1, input.reputationScore);
  const scarcityBonus = input.similarSkillCount <= 2 ? 1.5 : input.similarSkillCount <= 5 ? 1.2 : 1.0;

  const rawPrice = cfg.basePriceUsdc * (1 + qualityMultiplier) * demandMultiplier * reputationMultiplier * scarcityBonus;
  const priceUsdc = Math.max(cfg.minPriceUsdc, Math.min(cfg.maxPriceUsdc, rawPrice));

  return {
    priceUsdc: Math.round(priceUsdc * 1000000) / 1000000, // 6 decimal places (USDC precision)
    listable: true,
    breakdown: {
      basePrice: cfg.basePriceUsdc,
      qualityMultiplier,
      demandMultiplier,
      reputationMultiplier,
      scarcityBonus,
    },
  };
}
