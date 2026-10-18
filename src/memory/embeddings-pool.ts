/**
 * PLAN-57 §4.6: the `pool` embedding provider.
 *
 * A wrapper around the node's own provider that may run a batch on a
 * compute pool worker instead, under three hard rules the code enforces:
 *
 * 1. Compatibility. A pool result is written only when the worker's model
 *    digest, dimensions and processing rules equal the local embedding
 *    profile. Any mismatch puts that worker in cooldown and runs the batch
 *    locally. There is never a per-batch mix.
 * 2. Egress. Each input carries a governance class; the batch is split by
 *    class and each part is routed under its own ceiling (confidential:
 *    local; personal: trusted pools; normal: any pool). Inputs with no class
 *    count as personal. The agent cannot change this.
 * 3. Nothing waits on the pool. A slow or failed pool batch falls back to
 *    local for that batch, and the ledger says so.
 *
 * The wrapper keeps the local provider's id and model, so an index keyed by
 * them is unchanged by routing: routing decides where an identical
 * computation runs, never which. Queries always run locally.
 */

import { createHash } from "node:crypto";
import {
  type ComputeBackend,
  COMPUTE_MAX_INPUTS,
  getComputeBackend,
} from "../compute/awareness/backend.js";
import {
  type GovernanceClass,
  classifyForEgress,
  egressPermitted,
  groupByClass,
  resolvePoolTrust,
} from "../compute/awareness/egress.js";
import { recordComputeDuration } from "../compute/awareness/estimate.js";
import type { ComputeLedgerRow } from "../compute/awareness/ledger.js";
import {
  type CooldownReason,
  CooldownBook,
  LOCAL_WORKER_ID,
  chooseEmbeddingRoute,
} from "../compute/awareness/routing.js";
import { type ComputeRuntime, getComputeRuntime } from "../compute/awareness/runtime.js";
import { pushComputeTransition } from "../compute/awareness/state.js";
import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  type EmbeddingProfile,
  embeddingProfileKey,
  poolProfileFromExecution,
  poolResultParityFailure,
} from "./embedding-profile.js";
import { type EmbedCallOptions, recordEmbeddingUsage } from "./embeddings-usage.js";
import { type EmbeddingProvider, sanitizeAndNormalizeEmbedding } from "./embeddings.js";

const log = createSubsystemLogger("memory/embeddings-pool");

export const DEFAULT_POOL_MARGIN_MS = 500;
export const DEFAULT_POOL_COOLDOWN_MS = 300_000;
export const DEFAULT_POOL_TIMEOUT_MS = 60_000;
const POLL_MS = 500;
/** After this many pool batches in a row fell back, one event tells the agent local is in effect. */
export const SUSTAINED_FALLBACK_THRESHOLD = 10;

export type PoolEmbeddingDeps = {
  backend?: () => ComputeBackend | null;
  runtime?: () => ComputeRuntime | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type PoolEmbeddingProvider = EmbeddingProvider & {
  routing: "pool";
  local: EmbeddingProvider;
  cooldowns: CooldownBook;
};

export function isPoolEmbeddingProvider(p: EmbeddingProvider): p is PoolEmbeddingProvider {
  return (p as { routing?: unknown }).routing === "pool";
}

type Terminal = { status: string; worker?: string };
const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled", "refunded"]);

export function createPoolEmbeddingProvider(params: {
  local: EmbeddingProvider;
  config: BitterbotConfig;
  agentId?: string;
  /** The manager's live profile; `null` until resolved, and routing stays local until then. */
  getProfile: () => EmbeddingProfile | null;
  deps?: PoolEmbeddingDeps;
}): PoolEmbeddingProvider {
  const { local, config } = params;
  const deps = {
    backend: params.deps?.backend ?? getComputeBackend,
    runtime: params.deps?.runtime ?? getComputeRuntime,
    now: params.deps?.now ?? Date.now,
    sleep: params.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const cfg = config.compute?.embeddings;
  const marginMs = cfg?.marginMs ?? DEFAULT_POOL_MARGIN_MS;
  const cooldownMs = cfg?.cooldownMs ?? DEFAULT_POOL_COOLDOWN_MS;
  const timeoutMs = cfg?.timeoutMs ?? DEFAULT_POOL_TIMEOUT_MS;
  const cooldowns = new CooldownBook();
  let consecutiveFallbacks = 0;
  let sustainedEventSent = false;

  const runLocal = async (
    texts: string[],
    opts: EmbedCallOptions | undefined,
  ): Promise<{ vectors: number[][]; ms: number }> => {
    const started = deps.now();
    const vectors = await local.embedBatch(texts, opts);
    const ms = Math.max(1, deps.now() - started);
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: texts.length,
      durationMs: ms,
    });
    return { vectors, ms };
  };

  const embedBatch = async (texts: string[], opts?: EmbedCallOptions): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const backend = deps.backend();
    const runtime = deps.runtime();
    const profile = params.getProfile();
    // No pool on this node, or nothing to compare against yet: plain local.
    if (!backend?.submit || !runtime || !profile) {
      return (await runLocal(texts, opts)).vectors;
    }
    const ledger = runtime.store.ledger();
    const profileKey = embeddingProfileKey(profile);
    const classes: GovernanceClass[] = texts.map(
      (t, i) => opts?.classes?.[i] ?? classifyForEgress({ text: t, config }),
    );
    const out: number[][] = Array.from({ length: texts.length }, () => []);
    let snapshot = null;
    try {
      snapshot = await backend.snapshot();
    } catch (err) {
      log.debug(`compute snapshot unavailable: ${String(err)}`);
    }
    const now = deps.now();
    const poolTrust = (poolId: string) => resolvePoolTrust(config, poolId);

    const write = (indices: number[], vectors: number[][]) => {
      indices.forEach((idx, j) => {
        out[idx] = vectors[j] ?? [];
      });
    };
    const ledgerRow = (row: Omit<ComputeLedgerRow, "ts" | "profileKey">) => {
      try {
        ledger.record({ ts: deps.now(), profileKey, ...row });
      } catch (err) {
        log.debug(`compute ledger write failed: ${String(err)}`);
      }
    };
    const fallback = async (
      indices: number[],
      cls: GovernanceClass,
      reason: CooldownReason,
      detail: string,
      route: { poolId: string; workerId: string; trust: ComputeLedgerRow["trust"] },
      jobId: string | null,
    ) => {
      cooldowns.enter(route.workerId, reason, deps.now(), cooldownMs, detail);
      log.warn(
        `pool embeddings: ${route.workerId} (${route.poolId}) ${reason}: ${detail}; batch of ${indices.length} runs locally, worker in cooldown ${Math.round(cooldownMs / 1000)}s`,
      );
      const slice = indices.map((i) => texts[i]!);
      const started = deps.now();
      const r = await runLocal(slice, { ...opts, classes: undefined });
      write(indices, r.vectors);
      ledgerRow({
        route: "fallback",
        poolId: route.poolId,
        workerId: route.workerId,
        trust: route.trust,
        cls,
        items: indices.length,
        jobId,
        durationMs: deps.now() - started,
        reason,
        receiptHash: null,
      });
      consecutiveFallbacks += 1;
      if (consecutiveFallbacks >= SUSTAINED_FALLBACK_THRESHOLD && !sustainedEventSent) {
        sustainedEventSent = true;
        log.error(
          `pool embeddings: ${consecutiveFallbacks} batches in a row fell back to local (last: ${reason}); local embedding is in effect`,
        );
        pushComputeTransition({
          jobId: "embeddings",
          status: "degraded",
          summary: `pool embeddings falling back to local (${reason})`,
          at: deps.now(),
        });
      }
    };

    for (const [cls, indices] of groupByClass(classes)) {
      const route = chooseEmbeddingRoute({
        snapshot,
        items: indices.length,
        cls,
        modelDigest: profile.modelDigest,
        dimensions: profile.dimensions,
        poolTrust,
        cooldowns,
        marginMs,
        now,
      });
      if (route.kind === "local") {
        const slice = indices.map((i) => texts[i]!);
        const r = await runLocal(slice, { ...opts, classes: undefined });
        write(indices, r.vectors);
        ledgerRow({
          route: "local",
          poolId: null,
          workerId: null,
          trust: null,
          cls,
          items: indices.length,
          jobId: null,
          durationMs: r.ms,
          reason: route.reason,
          receiptHash: null,
        });
        continue;
      }
      // Defence in depth: the router already applied the ceiling; a wrong
      // answer here is a bug, and it still never ships the content.
      if (!egressPermitted(cls, route.trust)) {
        await fallback(
          indices,
          cls,
          "policy_violation",
          `${cls} content offered to ${route.trust} pool ${route.poolId}`,
          route,
          null,
        );
        continue;
      }
      for (let start = 0; start < indices.length; start += COMPUTE_MAX_INPUTS) {
        const part = indices.slice(start, start + COMPUTE_MAX_INPUTS);
        const slice = part.map((i) => texts[i]!);
        const started = deps.now();
        let jobId: string | null = null;
        try {
          const submitted = await backend.submit({
            mode:
              route.poolKind === "collective"
                ? { kind: "collective", projectId: route.poolId }
                : { kind: "private", poolId: route.poolId },
            workload: "embeddings",
            inputs: slice,
            model: profile.model,
            modelDigest: profile.modelDigest,
            // Unique per attempt: the provider never retries a submit, and a
            // replayed old job (expired, cancelled) must not be mistaken for this one.
            idempotencyKey: `internal:${sha256(`${slice.join("\u0000")}${profileKey}${started}`).slice(0, 32)}`,
          });
          jobId = submitted.id;
          runtime.store.recordOrigin(jobId, "internal", null, { now: deps.now() });
          runtime.watcher?.kick();
          const terminal = await waitForTerminal(backend, jobId, started);
          if (!terminal) {
            try {
              await backend.cancel?.(jobId);
            } catch {
              // best effort
            }
            await fallback(part, cls, "timeout", `no result after ${timeoutMs}ms`, route, jobId);
            continue;
          }
          if (terminal.status !== "succeeded") {
            await fallback(part, cls, "error", `job ${terminal.status}`, route, jobId);
            continue;
          }
          const res = await backend.result(jobId);
          const vectors = readVectors(res?.result);
          const parity = poolResultParityFailure({
            local: profile,
            remote: poolProfileFromExecution(
              (res?.result as { execution?: unknown } | null)?.execution,
            ),
            vectors,
            expectedCount: slice.length,
          });
          if (parity) {
            await fallback(part, cls, parity.reason, parity.detail, route, jobId);
            continue;
          }
          const finished =
            profile.normalise === "l2" ? vectors.map(sanitizeAndNormalizeEmbedding) : vectors;
          write(part, finished);
          const ms = Math.max(1, deps.now() - started);
          const workerId = terminal.worker ?? route.workerId;
          recordComputeDuration({
            workerId,
            workload: "embeddings",
            items: slice.length,
            durationMs: ms,
          });
          recordEmbeddingUsage({
            providerId: "pool",
            model: profile.model,
            texts: slice,
            feature: opts?.feature,
            agentId: params.agentId,
            batch: true,
            durationMs: ms,
            local: true,
          });
          ledgerRow({
            route: "pool",
            poolId: route.poolId,
            workerId,
            trust: route.trust,
            cls,
            items: slice.length,
            jobId,
            durationMs: ms,
            reason: null,
            receiptHash: res?.receipt ? sha256(JSON.stringify(res.receipt)) : null,
          });
          consecutiveFallbacks = 0;
          sustainedEventSent = false;
        } catch (err) {
          await fallback(
            part,
            cls,
            "error",
            String(err instanceof Error ? err.message : err),
            route,
            jobId,
          );
        }
      }
    }
    return out;
  };

  async function waitForTerminal(
    backend: ComputeBackend,
    jobId: string,
    started: number,
  ): Promise<Terminal | null> {
    while (deps.now() - started < timeoutMs) {
      const j = await backend.job(jobId);
      if (j && TERMINAL.has(j.status)) {
        return { status: j.status, worker: j.worker };
      }
      await deps.sleep(POLL_MS);
    }
    return null;
  }

  return {
    id: local.id,
    model: local.model,
    maxInputTokens: local.maxInputTokens,
    resolveDigest: local.resolveDigest,
    routing: "pool",
    local,
    cooldowns,
    embedQuery: (text, opts) => local.embedQuery(text, opts),
    embedBatch,
  };
}

/** Soapbox returns `{embeddings: number[][], execution}`; accept `vectors` too. Anything else is an empty result. */
export function readVectors(result: unknown): number[][] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const r = result as { embeddings?: unknown; vectors?: unknown };
  const raw = Array.isArray(r.embeddings)
    ? r.embeddings
    : Array.isArray(r.vectors)
      ? r.vectors
      : null;
  if (!raw) {
    return [];
  }
  return raw.map((v) =>
    Array.isArray(v) ? v.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)) : [],
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
