/**
 * PLAN-57 Phase 0: the compute backend seam.
 *
 * The agent's `compute` tool and the static "Compute" prompt section only
 * exist when a backend is registered here. The Soapbox plugin registers one
 * when it loads; with no backend there is no tool, no prompt text and no
 * cost, which is the zero-cost invariant of the plan.
 *
 * Everything the agent sees goes through `ComputeSnapshot`, a narrow,
 * secret-free view. Bearer tokens, RPC URLs, escrow addresses and wallet
 * secrets never enter it: `snapshotFromSoapboxStatus` copies named fields
 * only, never whole objects.
 */

export type ComputeWorkloadKind = "sha256" | "embeddings";

export type ComputeWorker = {
  id: string;
  online: boolean;
  paused: boolean;
  gpu: boolean;
  cpuThreads: number;
  memoryMib: number;
  /** Pool and project ids this worker accepts work from. */
  pools: string[];
  projects: string[];
  modes: string[];
  /** Pinned embedding model this worker runs, when it runs one. */
  model?: string;
  modelDigest?: string;
  /** How the worker is isolated, as it reports it (not attested). */
  isolation?: string;
  gpuUnavailableReason?: string;
};

export type ComputePool = {
  id: string;
  kind: "private" | "collective";
  /** The owner's trust level for this pool (PLAN-57 §4.6). `local` is this machine. */
  trust: "local" | "trusted" | "untrusted";
  workersOnline: number;
  workersTotal: number;
  gpuWorkersOnline: number;
};

export type ComputeJobSummary = {
  id: string;
  status: string;
  mode: string;
  /** Pool or project id for private/collective jobs. */
  scope?: string;
  workload: ComputeWorkloadKind;
  items: number;
  attempts: number;
  /** Set when the coordinator reports a worker for the job. */
  worker?: string;
  /** Which check the result passed: recomputed, shape_only_trusted_worker, redundant. */
  verification?: string;
  error?: string;
  /** Paid jobs waiting on the owner: amount in test USDC, never funded by the agent. */
  awaitingUsdc?: number;
};

export type ComputeCredits = {
  available: number;
  reserved: number;
  currency: string;
};

export type ComputeSnapshot = {
  /** Monotonic per process; a new snapshot always has a higher version. */
  version: number;
  /** Epoch ms the snapshot was taken. */
  asOf: number;
  /** False when the backend is configured but the coordinator is unreachable. */
  reachable: boolean;
  settlement?: string;
  credits?: ComputeCredits;
  pools: ComputePool[];
  workers: ComputeWorker[];
  jobs: ComputeJobSummary[];
};

export type ComputeResult = {
  id: string;
  status: string;
  /** JSON-serialisable result, already stripped of anything the agent must not see. */
  result: unknown;
  receipt: unknown;
  verification?: string;
  error?: string;
};

export type ComputeBackend = {
  /** Current view. Implementations should serve a cached snapshot; the tool never polls. */
  snapshot(): Promise<ComputeSnapshot>;
  /** Jobs visible to this node, newest first. */
  jobs(opts?: { limit?: number; status?: string }): Promise<ComputeJobSummary[]>;
  job(id: string): Promise<ComputeJobSummary | null>;
  result(id: string): Promise<ComputeResult | null>;
};

let registered: ComputeBackend | null = null;

export function registerComputeBackend(backend: ComputeBackend | null): void {
  registered = backend;
}

export function getComputeBackend(): ComputeBackend | null {
  return registered;
}

export function resetComputeBackendForTest(): void {
  registered = null;
}

// ── Soapbox adapter ──
//
// A structural copy of the fields the plugin's `soapbox.status` payload
// carries (see the Soapbox client in the plugin). Kept here, not imported,
// so core has no dependency on the plugin and the plugin can evolve its
// wire type without touching the agent surface.

export type SoapboxStatusLike = {
  enabled: boolean;
  settlement?: string;
  principal?: { id: string; roles: string[]; pools: string[]; projects: string[] };
  account?: { available_credits: number; reserved_credits: number; currency: string };
  nodes?: Array<{
    id: string;
    online: boolean;
    operator_paused?: boolean;
    offer: {
      cpu_threads: number;
      memory_mib: number;
      gpu_observed: boolean;
      modes: string[];
      paused: boolean;
      models?: string[];
      pools?: string[];
      projects?: string[];
      runtime?: { model: string; model_digest: string } | null;
      gpu_unavailable_reason?: string | null;
      isolation?: string | null;
    };
  }>;
  jobs?: SoapboxJobLike[];
};

export type SoapboxJobLike = {
  id: string;
  status: string;
  attempts: number;
  worker?: string | null;
  spec: {
    mode:
      | { kind: "paid"; max_cost_credits: number }
      | { kind: "paid_usdc"; max_cost_microusdc: number; operator: string }
      | { kind: "private"; pool_id: string }
      | { kind: "collective"; project_id: string };
    workload: { kind: ComputeWorkloadKind; texts: string[]; model?: string; model_digest?: string };
  };
  receipt?: unknown;
  error?: string | null;
  payment?: { amount_microusdc: number } | null;
};

let versionCounter = 0;

/** Pool trust levels come from config; unknown pools default to `untrusted`. */
export type PoolTrustResolver = (poolId: string) => ComputePool["trust"];

const LOCAL_POOL_IDS = new Set(["local"]);

export function defaultPoolTrust(poolId: string): ComputePool["trust"] {
  return LOCAL_POOL_IDS.has(poolId) ? "local" : "untrusted";
}

/** Narrow the Soapbox status into the secret-free snapshot the agent sees. */
export function snapshotFromSoapboxStatus(
  status: SoapboxStatusLike,
  opts: { now?: number; reachable?: boolean; poolTrust?: PoolTrustResolver } = {},
): ComputeSnapshot {
  const now = opts.now ?? Date.now();
  const trustOf = opts.poolTrust ?? defaultPoolTrust;
  versionCounter += 1;

  const workers: ComputeWorker[] = (status.nodes ?? []).map((n) => {
    const w: ComputeWorker = {
      id: n.id,
      online: n.online,
      paused: Boolean(n.operator_paused || n.offer.paused),
      gpu: Boolean(n.offer.gpu_observed),
      cpuThreads: n.offer.cpu_threads,
      memoryMib: n.offer.memory_mib,
      pools: [...(n.offer.pools ?? [])],
      projects: [...(n.offer.projects ?? [])],
      modes: [...(n.offer.modes ?? [])],
    };
    if (n.offer.runtime?.model) {
      w.model = n.offer.runtime.model;
      w.modelDigest = n.offer.runtime.model_digest;
    } else if (n.offer.models?.[0]) {
      w.model = n.offer.models[0];
    }
    if (n.offer.isolation) {
      w.isolation = n.offer.isolation;
    }
    if (n.offer.gpu_unavailable_reason) {
      w.gpuUnavailableReason = clip(n.offer.gpu_unavailable_reason, 120);
    }
    return w;
  });

  // Pools and projects the principal belongs to, with worker counts derived
  // from the offers that accept them.
  const pools: ComputePool[] = [];
  for (const id of status.principal?.pools ?? []) {
    pools.push(poolEntry(id, "private", trustOf(id), workers, (w) => w.pools.includes(id)));
  }
  for (const id of status.principal?.projects ?? []) {
    pools.push(poolEntry(id, "collective", trustOf(id), workers, (w) => w.projects.includes(id)));
  }

  const jobs: ComputeJobSummary[] = (status.jobs ?? []).map(summariseSoapboxJob);

  const snapshot: ComputeSnapshot = {
    version: versionCounter,
    asOf: now,
    reachable: opts.reachable ?? true,
    pools,
    workers,
    jobs,
  };
  if (status.settlement) {
    snapshot.settlement = status.settlement;
  }
  if (status.account) {
    snapshot.credits = {
      available: status.account.available_credits,
      reserved: status.account.reserved_credits,
      currency: status.account.currency,
    };
  }
  return snapshot;
}

export function summariseSoapboxJob(j: SoapboxJobLike): ComputeJobSummary {
  const mode = j.spec.mode;
  const s: ComputeJobSummary = {
    id: j.id,
    status: j.status,
    mode: mode.kind,
    workload: j.spec.workload.kind,
    items: j.spec.workload.texts.length,
    attempts: j.attempts,
  };
  if (mode.kind === "private") {
    s.scope = mode.pool_id;
  } else if (mode.kind === "collective") {
    s.scope = mode.project_id;
  }
  if (j.worker) {
    s.worker = j.worker;
  }
  const verification = receiptVerification(j.receipt);
  if (verification) {
    s.verification = verification;
  }
  if (j.error) {
    s.error = clip(j.error, 200);
  }
  if (j.status === "awaiting_payment" && j.payment) {
    s.awaitingUsdc = j.payment.amount_microusdc / 1_000_000;
  }
  return s;
}

function poolEntry(
  id: string,
  kind: ComputePool["kind"],
  trust: ComputePool["trust"],
  workers: ComputeWorker[],
  accepts: (w: ComputeWorker) => boolean,
): ComputePool {
  const members = workers.filter(accepts);
  const online = members.filter((w) => w.online && !w.paused);
  return {
    id,
    kind,
    trust,
    workersTotal: members.length,
    workersOnline: online.length,
    gpuWorkersOnline: online.filter((w) => w.gpu).length,
  };
}

function receiptVerification(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== "object") {
    return undefined;
  }
  const v = (receipt as { verification?: unknown }).verification;
  return typeof v === "string" ? v : undefined;
}

export function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
