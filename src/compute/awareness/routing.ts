/**
 * PLAN-57 §4.6 routing: deterministic, no model call. Among workers that
 * are eligible (online, not paused, GPU, same model digest) and permitted
 * (pool trust within the class ceiling), choose the pool when its estimate
 * beats local by the configured margin and it is not in cooldown. Otherwise
 * local. Routing decides where an identical computation runs, never which.
 */

import type { ComputeSnapshot, ComputeWorker } from "./backend.js";
import { CLASS_CEILING, type GovernanceClass, type PoolTrust, TRUST_RANK } from "./egress.js";
import { learnedMsPerItem } from "./estimate.js";

export type CooldownReason =
  | "timeout"
  | "digest_mismatch"
  | "dimension_mismatch"
  | "processing_mismatch"
  | "count_mismatch"
  | "policy_violation"
  | "error";

export type Cooldown = { workerId: string; reason: CooldownReason; until: number; detail?: string };

/** Per-process memory of workers to skip, with the reason, for the doctor and the ledger. */
export class CooldownBook {
  private readonly entries = new Map<string, Cooldown>();

  enter(
    workerId: string,
    reason: CooldownReason,
    now: number,
    ms: number,
    detail?: string,
  ): Cooldown {
    const c: Cooldown = { workerId, reason, until: now + ms, detail };
    this.entries.set(workerId, c);
    return c;
  }

  active(workerId: string, now: number): Cooldown | null {
    const c = this.entries.get(workerId);
    if (!c) {
      return null;
    }
    if (c.until <= now) {
      this.entries.delete(workerId);
      return null;
    }
    return c;
  }

  list(now: number): Cooldown[] {
    return [...this.entries.values()].filter((c) => c.until > now);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const LOCAL_WORKER_ID = "local";
/** Until local has a measured batch, nothing routes to the pool; this is what a CPU batch costs per item meanwhile. */
const LOCAL_PRIOR_MS_PER_ITEM = 400;
const POOL_FIXED_OVERHEAD_MS = 1500;

export type EmbeddingRoute =
  | { kind: "local"; reason: string }
  | {
      kind: "pool";
      poolId: string;
      poolKind: "private" | "collective";
      workerId: string;
      trust: PoolTrust;
      estMs: number;
      localEstMs: number;
      reason: string;
    };

export function chooseEmbeddingRoute(params: {
  snapshot: ComputeSnapshot | null;
  items: number;
  cls: GovernanceClass;
  modelDigest: string | undefined;
  dimensions: number | undefined;
  poolTrust: (poolId: string) => PoolTrust;
  cooldowns: CooldownBook;
  marginMs: number;
  now: number;
}): EmbeddingRoute {
  const { snapshot } = params;
  if (!snapshot || !snapshot.reachable) {
    return { kind: "local", reason: "coordinator unreachable" };
  }
  if (!params.modelDigest) {
    return { kind: "local", reason: "local profile has no model digest" };
  }
  if (!params.dimensions) {
    return { kind: "local", reason: "local dimensions not yet known" };
  }
  const ceiling = CLASS_CEILING[params.cls];
  if (ceiling === "local") {
    return { kind: "local", reason: `${params.cls} content stays local` };
  }
  const localPerItem = learnedMsPerItem(LOCAL_WORKER_ID, "embeddings");
  if (localPerItem === null) {
    return { kind: "local", reason: "no local timing yet" };
  }
  const localEstMs = Math.round(localPerItem * params.items);
  const poolsById = new Map(snapshot.pools.map((p) => [p.id, p]));

  type Candidate = {
    w: ComputeWorker;
    poolId: string;
    poolKind: "private" | "collective";
    trust: PoolTrust;
    estMs: number;
  };
  const candidates: Candidate[] = [];
  const rejected: string[] = [];
  for (const w of snapshot.workers) {
    if (!w.online || w.paused) {
      continue;
    }
    if (!w.gpu) {
      rejected.push(`${w.id}: no GPU`);
      continue;
    }
    if (w.modelDigest !== params.modelDigest) {
      rejected.push(`${w.id}: different model`);
      continue;
    }
    const cd = params.cooldowns.active(w.id, params.now);
    if (cd) {
      rejected.push(`${w.id}: cooldown (${cd.reason})`);
      continue;
    }
    // The most restrictive pool this worker serves that the class may reach.
    let best: { poolId: string; poolKind: "private" | "collective"; trust: PoolTrust } | null =
      null;
    for (const poolId of [...w.pools, ...w.projects]) {
      const trust = params.poolTrust(poolId);
      if (trust === "local") {
        continue; // this machine: the in-process provider already is local
      }
      if (TRUST_RANK[trust] > TRUST_RANK[ceiling]) {
        continue;
      }
      const kind =
        poolsById.get(poolId)?.kind ?? (w.projects.includes(poolId) ? "collective" : "private");
      if (!best || TRUST_RANK[trust] < TRUST_RANK[best.trust]) {
        best = { poolId, poolKind: kind, trust };
      }
    }
    if (!best) {
      rejected.push(`${w.id}: no pool within ${ceiling} trust`);
      continue;
    }
    const learned = learnedMsPerItem(w.id, "embeddings");
    const perItem = learned ?? 40;
    const estMs = Math.round(POOL_FIXED_OVERHEAD_MS + perItem * params.items);
    candidates.push({ w, ...best, estMs });
  }
  candidates.sort((a, b) => a.estMs - b.estMs || a.w.id.localeCompare(b.w.id));
  const pick = candidates[0];
  if (!pick) {
    return {
      kind: "local",
      reason: rejected.length ? rejected.slice(0, 3).join("; ") : "no pool workers",
    };
  }
  if (pick.estMs + params.marginMs >= localEstMs) {
    return {
      kind: "local",
      reason: `local ${localEstMs}ms beats ${pick.w.id} ${pick.estMs}ms + margin`,
    };
  }
  return {
    kind: "pool",
    poolId: pick.poolId,
    poolKind: pick.poolKind,
    workerId: pick.w.id,
    trust: pick.trust,
    estMs: pick.estMs,
    localEstMs,
    reason: `${pick.w.id} ${pick.estMs}ms vs local ${localEstMs}ms`,
  };
}

export const LOCAL_PRIOR_MS = LOCAL_PRIOR_MS_PER_ITEM;
