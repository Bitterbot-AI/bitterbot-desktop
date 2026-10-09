import type { BitterbotConfig } from "../../../config/config.js";

/**
 * Floor for the compaction reserve (tokens kept free below the context
 * window before compaction triggers). `agents.defaults.compaction.reserveTokensFloor`
 * raises or lowers it; the session applies the larger of this and its default.
 */
export const DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

export function resolveCompactionReserveTokensFloor(cfg?: BitterbotConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.reserveTokensFloor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR;
}
