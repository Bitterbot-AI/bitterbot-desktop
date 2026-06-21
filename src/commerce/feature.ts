/**
 * Feature gate for the Aubaine group-buy coordination layer (PLAN-26).
 *
 * Centralizes the read of `config.commerce.groupbuy.*` so every call site
 * (directory, matcher, settlement, the group_buy tool, the clearinghouse HTTP
 * surface) gates on one place. Off by default until Phase 3 ships.
 */
import type { BitterbotConfig } from "../config/types.bitterbot.js";

export function isAubaineEnabled(config: BitterbotConfig | undefined): boolean {
  return config?.commerce?.groupbuy?.enabled ?? false;
}

export function coordinatorFeeBps(config: BitterbotConfig | undefined): number {
  return config?.commerce?.groupbuy?.coordinatorFeeBps ?? 200;
}
