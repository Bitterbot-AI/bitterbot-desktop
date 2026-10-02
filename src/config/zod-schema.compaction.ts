import { z } from "zod";

/** `compaction.policy`, shared by `agents.defaults` and `agents.list[]`. */
export const CompactionPolicySchema = z.union([z.literal("summary"), z.literal("offload")]);

/** `compaction.offload`, shared by `agents.defaults` and `agents.list[]`. */
export const CompactionOffloadSchema = z
  .object({
    recallCrossSession: z.union([z.literal("off"), z.literal("owner")]).optional(),
    toolOutputStubs: z.boolean().optional(),
    triggerTurnEndFraction: z.number().min(0.1).max(0.95).optional(),
    triggerTurnStartFraction: z.number().min(0.1).max(0.98).optional(),
    triggerMidTurnFraction: z.number().min(0.1).max(0.98).optional(),
    targetFraction: z.number().min(0.05).max(0.9).optional(),
    midTurnTargetFraction: z.number().min(0.05).max(0.95).optional(),
    minKeepUserTurns: z.number().int().min(1).max(50).optional(),
    toolOutputStubMinTokens: z.number().int().nonnegative().optional(),
    spareRecentToolResults: z.number().int().min(0).max(20).optional(),
    elideHeartbeats: z.boolean().optional(),
    ledgerBudgetTokens: z.number().int().min(200).max(6000).optional(),
    minElidedTokens: z.number().int().nonnegative().optional(),
    summary: z.union([z.literal("off"), z.literal("idle"), z.literal("always")]).optional(),
    summaryModel: z.string().optional(),
    proactiveRecall: z.boolean().optional(),
    recallBudgetUsdPerDay: z.number().nonnegative().optional(),
  })
  .strict();
