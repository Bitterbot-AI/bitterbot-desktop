/**
 * PLAN-57 §4.3: the `<compute-state>` block.
 *
 * The watcher publishes snapshots and one-shot transitions here; the prompt
 * builder asks for a rendered block once per turn. Rendering is pure and
 * bounded: fixed line order, a monotonic version, an age marker, rounded
 * numbers, coordinator strings escaped and clipped, and a hard character
 * budget (about 120 tokens by default).
 *
 * The block is OMITTED entirely at steady state (only the local worker,
 * nothing running, nothing new), so an idle node spends nothing on it. It
 * is volatile by construction and must only ever be placed after the cache
 * boundary; nothing here is read by the heartbeat hash gate.
 */

import type { ComputeJobSummary, ComputePool, ComputeSnapshot } from "./backend.js";

export type ComputeTransition = {
  jobId: string;
  status: string;
  /** One short clause, already safe for the prompt. */
  summary: string;
  at: number;
};

type StateStore = {
  snapshot: ComputeSnapshot | null;
  transitions: ComputeTransition[];
  internalJobIds: Set<string>;
  deferredCount: number;
  lastShownPoolSignature: string | null;
};

const store: StateStore = {
  snapshot: null,
  transitions: [],
  internalJobIds: new Set(),
  deferredCount: 0,
  lastShownPoolSignature: null,
};

const MAX_PENDING_TRANSITIONS = 6;

export function publishComputeSnapshot(snapshot: ComputeSnapshot): void {
  store.snapshot = snapshot;
}

export function getComputeSnapshot(): ComputeSnapshot | null {
  return store.snapshot;
}

/** A terminal or owner-facing transition the agent has not been shown yet. */
export function pushComputeTransition(t: ComputeTransition): void {
  store.transitions = store.transitions.filter(
    (x) => !(x.jobId === t.jobId && x.status === t.status),
  );
  store.transitions.push(t);
  while (store.transitions.length > MAX_PENDING_TRANSITIONS) {
    store.transitions.shift();
  }
}

/** Jobs the embedding consumer and other internal callers started: never rendered. */
export function setComputeInternalJobs(ids: Iterable<string>): void {
  store.internalJobIds = new Set(ids);
}

/** Completions waiting because the wake budget is spent (§4.4). */
export function setComputeDeferredCount(n: number): void {
  store.deferredCount = Math.max(0, Math.floor(n));
}

export function resetComputeStateForTest(): void {
  store.snapshot = null;
  store.transitions = [];
  store.internalJobIds = new Set();
  store.deferredCount = 0;
  store.lastShownPoolSignature = null;
}

// ── Rendering ──

export const DEFAULT_COMPUTE_STATE_MAX_CHARS = 480;

const IN_FLIGHT = new Set(["queued", "running", "settlement_pending"]);
const NEEDS_OWNER = new Set(["awaiting_payment", "payment_review"]);

export type RenderComputeStateInput = {
  snapshot: ComputeSnapshot;
  transitions: ComputeTransition[];
  internalJobIds?: Set<string>;
  deferredCount?: number;
  creditFloor?: number;
  now?: number;
  maxChars?: number;
  /** Pool signature last shown; a change is a reason to render once. */
  lastShownPoolSignature?: string | null;
};

export type RenderedComputeState = {
  text: string;
  poolSignature: string;
};

/** Pure: returns undefined when nothing is actionable. */
export function renderComputeStateBlock(
  input: RenderComputeStateInput,
): RenderedComputeState | undefined {
  const s = input.snapshot;
  const now = input.now ?? Date.now();
  const internal = input.internalJobIds ?? new Set<string>();
  const visible = s.jobs.filter((j) => !internal.has(j.id));
  const inFlight = visible.filter((j) => IN_FLIGHT.has(j.status));
  const needsOwner = visible.filter((j) => NEEDS_OWNER.has(j.status));
  const transitions = input.transitions.filter((t) => !internal.has(t.jobId));
  const deferred = input.deferredCount ?? 0;
  const floor = input.creditFloor ?? 0;
  const creditsLow = s.credits !== undefined && s.credits.available < floor;
  const remotePools = s.pools.filter((p) => p.trust !== "local");
  const poolSignature = remotePools
    .map((p) => `${p.id}:${p.workersOnline}/${p.workersTotal}:${p.gpuWorkersOnline}`)
    .join(",");
  const poolsChanged =
    remotePools.length > 0 && poolSignature !== (input.lastShownPoolSignature ?? null);
  const unreachable = !s.reachable;

  const actionable =
    inFlight.length > 0 ||
    needsOwner.length > 0 ||
    transitions.length > 0 ||
    poolsChanged ||
    creditsLow ||
    deferred > 0 ||
    unreachable;
  if (!actionable) {
    return undefined;
  }

  const lines: string[] = [];
  if (unreachable) {
    lines.push("coordinator: unreachable (state may be stale)");
  }
  if (s.pools.length > 0) {
    lines.push(`pools: ${s.pools.map(renderPool).join(", ")}`);
  }
  if (s.credits && (creditsLow || needsOwner.length > 0 || inFlight.length > 0)) {
    lines.push(
      `credits: ${roundNum(s.credits.available)} ${esc(s.credits.currency)}${creditsLow ? " (low)" : ""}`,
    );
  }
  if (inFlight.length > 0) {
    lines.push(`jobs: ${renderJobGroup(inFlight)}`);
  }
  if (needsOwner.length > 0) {
    lines.push(`needs owner: ${needsOwner.map(renderNeedsOwner).join("; ")}`);
  }
  if (transitions.length > 0) {
    lines.push(
      `last: ${transitions
        .slice(-3)
        .map(
          (t) => `${esc(shortId(t.jobId))} ${esc(t.status)} ${ago(now - t.at)} (${esc(t.summary)})`,
        )
        .join("; ")}`,
    );
  }
  if (deferred > 0) {
    lines.push(
      `waiting: ${deferred} completion${deferred === 1 ? "" : "s"} held until the wake budget resets`,
    );
  }

  const head = `<compute-state v=${s.version} as_of=${ago(now - s.asOf)}>`;
  const tail = "</compute-state>";
  const maxChars = input.maxChars ?? DEFAULT_COMPUTE_STATE_MAX_CHARS;
  const text = fitToBudget(head, lines, tail, maxChars);
  return { text, poolSignature };
}

/** Render from the shared store and mark what was shown (one-shot lines). */
export function resolveComputeStateBlock(opts: {
  enabled?: boolean;
  creditFloor?: number;
  maxChars?: number;
  now?: number;
}): string | undefined {
  if (opts.enabled === false || !store.snapshot) {
    return undefined;
  }
  const rendered = renderComputeStateBlock({
    snapshot: store.snapshot,
    transitions: store.transitions,
    internalJobIds: store.internalJobIds,
    deferredCount: store.deferredCount,
    creditFloor: opts.creditFloor,
    maxChars: opts.maxChars,
    now: opts.now,
    lastShownPoolSignature: store.lastShownPoolSignature,
  });
  if (!rendered) {
    return undefined;
  }
  // Shown once: transitions drop, the pool signature is remembered.
  store.transitions = [];
  store.lastShownPoolSignature = rendered.poolSignature;
  return rendered.text;
}

/** Config-driven entry used by the prompt builders. */
export function resolveComputeStateBlockFromConfig(
  config:
    | {
        compute?: {
          enabled?: boolean;
          awareness?: { stateBlock?: boolean; maxTokens?: number; creditFloor?: number };
        };
      }
    | undefined,
  now?: number,
): string | undefined {
  const compute = config?.compute;
  if (compute?.enabled === false || compute?.awareness?.stateBlock === false) {
    return undefined;
  }
  const maxTokens = compute?.awareness?.maxTokens ?? 120;
  return resolveComputeStateBlock({
    creditFloor: compute?.awareness?.creditFloor ?? 10,
    maxChars: Math.max(160, Math.round(maxTokens * 4)),
    now,
  });
}

// ── helpers ──

function renderPool(p: ComputePool): string {
  const gpu = p.gpuWorkersOnline > 0 ? `, ${p.gpuWorkersOnline} gpu` : "";
  const trust = p.trust === "local" ? "" : `, ${p.trust}`;
  return `${esc(p.id)}(${p.workersOnline}/${p.workersTotal} online${gpu}${trust})`;
}

function renderJobGroup(jobs: ComputeJobSummary[]): string {
  const byStatus = new Map<string, ComputeJobSummary[]>();
  for (const j of jobs) {
    const list = byStatus.get(j.status) ?? [];
    list.push(j);
    byStatus.set(j.status, list);
  }
  const parts: string[] = [];
  for (const status of ["running", "queued", "settlement_pending"]) {
    const list = byStatus.get(status);
    if (!list || list.length === 0) {
      continue;
    }
    const detail = list
      .slice(0, 3)
      .map(
        (j) => `${esc(j.workload)} x${j.items}${j.worker ? ` on ${esc(shortId(j.worker))}` : ""}`,
      )
      .join(", ");
    const more = list.length > 3 ? `, +${list.length - 3}` : "";
    parts.push(`${list.length} ${status} (${detail}${more})`);
  }
  return parts.join("; ");
}

function renderNeedsOwner(j: ComputeJobSummary): string {
  const cost = j.awaitingUsdc !== undefined ? ` ${roundNum(j.awaitingUsdc)} USDC` : "";
  return `${esc(shortId(j.id))} ${esc(j.status)}${cost}`;
}

function fitToBudget(head: string, lines: string[], tail: string, maxChars: number): string {
  const assemble = (ls: string[]) => [head, ...ls, tail].join("\n");
  let current = lines.slice();
  let text = assemble(current);
  // Drop detail from the end of the lowest-value lines first: last, pools, jobs.
  const dropOrder = ["last:", "pools:", "jobs:", "credits:"];
  for (const prefix of dropOrder) {
    if (text.length <= maxChars) {
      break;
    }
    const idx = current.findIndex((l) => l.startsWith(prefix));
    if (idx === -1) {
      continue;
    }
    const budget = Math.max(24, maxChars - (text.length - current[idx].length));
    current[idx] = clipLine(current[idx], budget);
    text = assemble(current);
  }
  if (text.length > maxChars) {
    current = current.filter(
      (l) => l.startsWith("needs owner:") || l.startsWith("waiting:") || l.startsWith("jobs:"),
    );
    text = assemble(
      current.map((l) =>
        clipLine(l, Math.max(24, Math.floor(maxChars / Math.max(1, current.length)) - 4)),
      ),
    );
  }
  return text;
}

function clipLine(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}

/** Coordinator strings are data, not markup: no angle brackets, no newlines. */
export function esc(value: string): string {
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 64);
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function roundNum(n: number): string {
  if (!Number.isFinite(n)) {
    return "?";
  }
  return Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s_ago`;
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m}m_ago`;
  }
  const h = Math.round(m / 60);
  return `${h}h_ago`;
}
