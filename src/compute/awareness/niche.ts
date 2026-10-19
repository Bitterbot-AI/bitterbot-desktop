/**
 * PLAN-57 §4.7: the compute facts for The Niche section of working memory,
 * over a rolling 7-day window. Read from the compute ledger and the delivery
 * tables at synthesis time (every dream cycle rewrites working memory, so no
 * extra scheduler): jobs consumed per origin and outcome, embedding batches
 * routed per pool trust and class, paid jobs funded, and the pools this node
 * belongs to. When the node is an operator this is its requester-side
 * reputation. Everything here is secret-free and comes from local tables,
 * never from a coordinator call.
 *
 * Counting notes: the window is on the delivery's creation time, so jobs
 * reconciled after a gateway outage count in the week they were recorded; a
 * job with two terminal transitions (failed, then refunded) counts under
 * each; the success rate is succeeded over succeeded + failed + expired,
 * leaving cancelled and refunded jobs out.
 */

import type { ComputeSnapshot } from "./backend.js";
import type { ComputeDeliveryStore } from "./deliveries.js";

export const COMPUTE_NICHE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type ComputeNicheFacts = {
  windowDays: number;
  jobs: {
    total: number;
    byOrigin: { agent: number; owner: number };
    byOutcome: Record<string, number>;
    /** succeeded / (succeeded + failed + expired), null when nothing finished. */
    successRate: number | null;
  };
  embeddings: {
    batches: number;
    items: number;
    pool: number;
    local: number;
    fallback: number;
    poolByClassTrust: Record<string, number>;
    poolItemsPerSecond: number | null;
    localItemsPerSecond: number | null;
    policyViolations: number;
  };
  payments: { funded: number; fundedUsdc: number; refused: number };
  pools: Array<{
    id: string;
    kind: string;
    trust: string;
    workersOnline: number;
    workersTotal: number;
  }>;
  /** Null when no backend has published a snapshot. */
  reachable: boolean | null;
};

export function computeNicheFacts(params: {
  store: ComputeDeliveryStore;
  snapshot?: ComputeSnapshot | null;
  now?: number;
  windowMs?: number;
}): ComputeNicheFacts {
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? COMPUTE_NICHE_WINDOW_MS;
  const since = now - windowMs;
  const outcomes = params.store.jobOutcomes(since);
  const byOrigin = { agent: 0, owner: 0 };
  const byOutcome: Record<string, number> = {};
  let total = 0;
  for (const row of outcomes) {
    total += row.jobs;
    if (row.origin === "agent" || row.origin === "owner") {
      byOrigin[row.origin] += row.jobs;
    }
    byOutcome[row.transition] = (byOutcome[row.transition] ?? 0) + row.jobs;
  }
  const finished = (byOutcome.succeeded ?? 0) + (byOutcome.failed ?? 0) + (byOutcome.expired ?? 0);
  const successRate = finished > 0 ? round2((byOutcome.succeeded ?? 0) / finished) : null;

  const ledger = params.store.ledger();
  const emb = ledger.summary(since);
  const pay = ledger.paymentSummary(since);
  const snapshot = params.snapshot ?? null;
  return {
    windowDays: Math.round(windowMs / (24 * 60 * 60_000)),
    jobs: { total, byOrigin, byOutcome, successRate },
    embeddings: {
      batches: emb.batches,
      items: emb.items,
      pool: emb.byRoute.pool.batches,
      local: emb.byRoute.local.batches,
      fallback: emb.byRoute.fallback.batches,
      poolByClassTrust: emb.poolByClassTrust,
      poolItemsPerSecond: emb.poolItemsPerSecond,
      localItemsPerSecond: emb.localItemsPerSecond,
      policyViolations: emb.policyViolations,
    },
    payments: { funded: pay.funded, fundedUsdc: pay.fundedUsdc, refused: pay.refused },
    pools: (snapshot?.pools ?? []).map((p) => ({
      id: p.id,
      kind: p.kind,
      trust: p.trust,
      workersOnline: p.workersOnline,
      workersTotal: p.workersTotal,
    })),
    reachable: snapshot ? snapshot.reachable : null,
  };
}

/** True when there is anything worth telling the Niche about. */
export function hasComputeActivity(f: ComputeNicheFacts): boolean {
  return (
    f.jobs.total > 0 || f.embeddings.batches > 0 || f.payments.funded > 0 || f.pools.length > 0
  );
}

/** The input block for the working-memory synthesis prompt. */
export function renderComputeNicheInput(f: ComputeNicheFacts): string[] {
  const lines = [`## Input: Compute (last ${f.windowDays} days)`];
  if (f.pools.length > 0) {
    lines.push(
      `Pools: ${f.pools
        .map(
          (p) =>
            `${p.id} (${p.kind}, ${p.trust}, ${p.workersOnline}/${p.workersTotal} workers online)`,
        )
        .join("; ")}`,
    );
  } else {
    lines.push("Pools: none joined (local machine only).");
  }
  if (f.reachable === false) {
    lines.push("Coordinator: unreachable at the last check.");
  }
  if (f.jobs.total > 0) {
    const outcomes = Object.entries(f.jobs.byOutcome)
      .toSorted(([a], [b]) => outcomeRank(a) - outcomeRank(b))
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    lines.push(
      `Jobs consumed: ${f.jobs.total} (agent ${f.jobs.byOrigin.agent}, owner ${f.jobs.byOrigin.owner}); outcomes: ${outcomes}` +
        (f.jobs.successRate !== null
          ? `; success rate ${Math.round(f.jobs.successRate * 100)}%`
          : ""),
    );
  } else {
    lines.push("Jobs consumed: none.");
  }
  if (f.embeddings.batches > 0) {
    const egress = Object.entries(f.embeddings.poolByClassTrust)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    lines.push(
      `Memory embeddings: ${f.embeddings.batches} batches (${f.embeddings.items} items): pool ${f.embeddings.pool}, local ${f.embeddings.local}, fallback ${f.embeddings.fallback}` +
        (egress ? `; pool batches by class@trust: ${egress}` : "") +
        (f.embeddings.poolItemsPerSecond !== null && f.embeddings.localItemsPerSecond !== null
          ? `; throughput pool ${f.embeddings.poolItemsPerSecond}/s vs local ${f.embeddings.localItemsPerSecond}/s`
          : "") +
        (f.embeddings.policyViolations > 0
          ? `; ${f.embeddings.policyViolations} policy violation(s) caught by the guard`
          : ""),
    );
  }
  if (f.payments.funded > 0 || f.payments.refused > 0) {
    lines.push(
      `Paid compute: ${f.payments.funded} job(s) funded by the owner, ${f.payments.fundedUsdc} USDC` +
        (f.payments.refused > 0 ? `; ${f.payments.refused} funding request(s) refused` : ""),
    );
  }
  return lines;
}

const OUTCOME_ORDER = ["succeeded", "failed", "expired", "cancelled", "refunded"];

function outcomeRank(status: string): number {
  const i = OUTCOME_ORDER.indexOf(status);
  return i === -1 ? OUTCOME_ORDER.length : i;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
