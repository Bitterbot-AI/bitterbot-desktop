/**
 * PLAN-57 §4.6 egress policy: which memory may leave this machine, and for
 * which pool. A private pool restricts membership; its operators still see
 * the inputs. So the owner's trust in a pool, not the pool's kind, decides.
 *
 *   confidential -> local only
 *   personal     -> local or trusted
 *   normal       -> local, trusted or untrusted
 *
 * The policy is enforced in the embedding provider before anything is
 * batched, recorded on the ledger row, and cannot be changed by the agent.
 * Only the owner raises a pool's trust (`compute.pools.<id>.trust`).
 */

import type { BitterbotConfig } from "../../config/config.js";
import { defaultGovernance } from "../../memory/crystal.js";
import { maxSensitivity, type Sensitivity, tagSensitivity } from "../../memory/guest-access.js";
import type { MemorySource } from "../../memory/types.js";
import { type ComputePool, defaultPoolTrust } from "./backend.js";

export type GovernanceClass = Sensitivity;
export type PoolTrust = ComputePool["trust"];

export const TRUST_RANK: Record<PoolTrust, number> = { local: 0, trusted: 1, untrusted: 2 };

/** The least trusted pool each class may reach. */
export const CLASS_CEILING: Record<GovernanceClass, PoolTrust> = {
  confidential: "local",
  personal: "trusted",
  normal: "untrusted",
};

export function egressPermitted(cls: GovernanceClass, trust: PoolTrust): boolean {
  return TRUST_RANK[trust] <= TRUST_RANK[CLASS_CEILING[cls]];
}

/** The owner's trust for a pool: config, else `local` for the local pool, else `untrusted`. */
export function resolvePoolTrust(
  config: Pick<BitterbotConfig, "compute"> | undefined,
  poolId: string,
): PoolTrust {
  const fallback = defaultPoolTrust(poolId);
  if (fallback === "local") {
    return "local";
  }
  const configured = config?.compute?.pools?.[poolId]?.trust;
  return configured === "trusted" ? "trusted" : "untrusted";
}

/**
 * Classify one chunk for egress. The source default (sessions -> the
 * configured transcript class, else `normal`) is raised by what the text
 * says, exactly as the governance tag written on the row is. Inputs with no
 * known source are treated as `personal`: they may reach trusted machines,
 * never untrusted ones.
 */
export function classifyForEgress(params: {
  text: string;
  source?: MemorySource;
  config?: Pick<BitterbotConfig, "compute">;
}): GovernanceClass {
  let base: GovernanceClass;
  if (!params.source) {
    base = "personal";
  } else if (params.source === "sessions") {
    base = params.config?.compute?.egress?.transcriptsDefaultClass ?? "personal";
  } else {
    base = defaultGovernance(params.source).sensitivity;
  }
  return maxSensitivity(base, tagSensitivity(params.text));
}

/** Group item indices by class, in first-seen order, so each sub-batch routes under its own ceiling. */
export function groupByClass(classes: readonly GovernanceClass[]): Map<GovernanceClass, number[]> {
  const groups = new Map<GovernanceClass, number[]>();
  classes.forEach((cls, i) => {
    const list = groups.get(cls);
    if (list) {
      list.push(i);
    } else {
      groups.set(cls, [i]);
    }
  });
  return groups;
}
