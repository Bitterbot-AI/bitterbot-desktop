/**
 * PLAN-57 follow-up: the Soapbox compute backend adapter.
 *
 * `ComputeBackend` is the seam the agent's `compute` tool, the prompt
 * section, the watcher and the paid-funding rail all talk to. Until this
 * file existed nothing in production registered one, so the whole
 * agent-facing compute surface stayed dormant in a stock install. The Soapbox
 * plugin now attaches this adapter in every mode that has a coordinator
 * client (pilot, participant, mesh-operator); setup-only mode registers
 * nothing, which keeps the zero-cost invariant.
 *
 * The adapter is a thin, secret-free mapping over the coordinator's HTTP API.
 * Snapshots are cached for a few seconds because the tool must never poll.
 * `fund()` is the signer: it verifies and consumes the approval token itself,
 * trusting nothing upstream, re-reads the quote from the coordinator and
 * refuses when it no longer matches the approved hash.
 */
import type { BitterbotConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import type { WalletConfig } from "../config/types.wallet.js";
import type {
  SoapboxClient,
  SoapboxJob,
  SoapboxPaymentQuote,
  SoapboxStatus,
} from "../infra/soapbox-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BitterbotPluginApi } from "../plugins/types.js";
import { fundApprovedSoapboxQuote } from "../services/soapbox-wallet.js";
import {
  COMPUTE_MAX_INPUTS,
  type ComputeBackend,
  type ComputeFundRequest,
  type ComputeFundResult,
  type ComputeJobSummary,
  type ComputeQuote,
  type ComputeResult,
  type ComputeSnapshot,
  type ComputeSubmitRequest,
  type ComputeSubmitResult,
  registerComputeBackend,
  snapshotFromSoapboxStatus,
  summariseSoapboxJob,
} from "./awareness/backend.js";
import { ComputeDeliveryStore } from "./awareness/deliveries.js";
import { resolvePoolTrust } from "./awareness/egress.js";
import { computeQuoteHash, toMicroUsdc, verifyComputeApprovalToken } from "./awareness/payment.js";
import { registerComputeRuntime } from "./awareness/runtime.js";
import { type ComputeWatcher, startComputeWatcher } from "./awareness/watcher.js";

const log = createSubsystemLogger("compute/soapbox-backend");

/** The slice of the coordinator client the adapter needs; tests pass a fake. */
export type SoapboxBackendClient = Pick<SoapboxClient, "status" | "request">;

export type SoapboxFunder = (
  quote: SoapboxPaymentQuote,
) => Promise<{ status: string; txHash: string | null }>;

export type SoapboxComputeBackendOptions = {
  client: SoapboxBackendClient;
  config?: Pick<BitterbotConfig, "compute">;
  /** Operators run no buyer wallet; `fund()` refuses for them. */
  role?: "buyer" | "operator";
  mainWallet?: WalletConfig;
  /** Overrides the wallet-backed funder (tests). */
  funder?: SoapboxFunder;
  now?: () => number;
  /** How long a status read serves `snapshot()` before the next read. */
  snapshotTtlMs?: number;
};

export const SOAPBOX_SNAPSHOT_TTL_MS = 5_000;
const DEFAULT_RESOURCES = {
  sha256: { cpu_threads: 1, memory_mib: 256, require_gpu: false },
  embeddings: { cpu_threads: 1, memory_mib: 1024, require_gpu: true },
} as const;

function isNotFound(err: unknown): boolean {
  return /\b(404|not found)\b/i.test(err instanceof Error ? err.message : String(err));
}

function quoteFromPayment(jobId: string, payment: SoapboxPaymentQuote): ComputeQuote {
  const amountUsdc = payment.amount_microusdc / 1_000_000;
  const network = `eip155:${payment.chain_id}`;
  return {
    jobId,
    amountUsdc,
    payee: payment.operator,
    network,
    expiresAt: payment.expires * 1000,
    quoteHash: computeQuoteHash({ jobId, amountUsdc, payee: payment.operator, network }),
  };
}

export function createSoapboxComputeBackend(opts: SoapboxComputeBackendOptions): ComputeBackend {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.snapshotTtlMs ?? SOAPBOX_SNAPSHOT_TTL_MS;
  const poolTrust = (poolId: string) => resolvePoolTrust(opts.config, poolId);
  let cached: { at: number; snapshot: ComputeSnapshot; status: SoapboxStatus | null } | null = null;
  let inflight: Promise<ComputeSnapshot> | null = null;
  const fundings = new Map<string, Promise<ComputeFundResult>>();

  const readStatus = async (): Promise<ComputeSnapshot> => {
    try {
      const status = await opts.client.status();
      const snapshot = snapshotFromSoapboxStatus(status, {
        now: now(),
        poolTrust,
        reachable: true,
      });
      cached = { at: now(), snapshot, status };
      return snapshot;
    } catch (err) {
      // Keep the last good view but mark it unreachable; an empty, unreachable
      // snapshot when there was never a good one.
      const base =
        cached?.snapshot ??
        snapshotFromSoapboxStatus({ enabled: true }, { now: now(), poolTrust, reachable: false });
      const snapshot: ComputeSnapshot = { ...base, asOf: now(), reachable: false };
      cached = { at: now(), snapshot, status: cached?.status ?? null };
      log.debug(`coordinator unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return snapshot;
    }
  };

  const snapshot = async (): Promise<ComputeSnapshot> => {
    if (cached && now() - cached.at < ttl) return cached.snapshot;
    if (!inflight) {
      inflight = readStatus().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  const getJob = async (id: string): Promise<SoapboxJob | null> => {
    try {
      return await opts.client.request<SoapboxJob>("GET", `/v1/jobs/${encodeURIComponent(id)}`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  const pickPaidOperator = async (): Promise<string> => {
    await snapshot();
    const nodes = cached?.status?.nodes ?? [];
    const eligible = nodes
      .filter(
        (n) =>
          n.online &&
          !n.operator_paused &&
          !n.offer.paused &&
          Array.isArray(n.offer.modes) &&
          n.offer.modes.includes("paid_usdc"),
      )
      .map((n) => n.id)
      .toSorted();
    if (eligible.length === 0)
      throw new Error("No online operator accepts paid USDC work right now");
    return eligible[0]!;
  };

  const backend: ComputeBackend = {
    snapshot,
    async jobs(listOpts) {
      const jobs = await opts.client.request<SoapboxJob[] | { jobs?: SoapboxJob[] }>(
        "GET",
        "/v1/jobs",
      );
      const list = Array.isArray(jobs) ? jobs : (jobs.jobs ?? []);
      let out = list.map(summariseSoapboxJob);
      if (listOpts?.status) out = out.filter((j) => j.status === listOpts.status);
      if (listOpts?.limit !== undefined) out = out.slice(0, Math.max(0, listOpts.limit));
      return out;
    },
    async job(id) {
      const job = await getJob(id);
      return job ? summariseSoapboxJob(job) : null;
    },
    async result(id) {
      const job = await getJob(id);
      if (!job) return null;
      const summary: ComputeJobSummary = summariseSoapboxJob(job);
      const result: ComputeResult = {
        id: job.id,
        status: job.status,
        result: job.result ?? null,
        receipt: job.receipt ?? null,
        ...(summary.verification ? { verification: summary.verification } : {}),
        ...(job.error ? { error: job.error } : {}),
      };
      return result;
    },
    async submit(req: ComputeSubmitRequest): Promise<ComputeSubmitResult> {
      if (!Array.isArray(req.inputs) || req.inputs.length === 0)
        throw new Error("At least one input is required");
      if (req.inputs.length > COMPUTE_MAX_INPUTS)
        throw new Error(`At most ${COMPUTE_MAX_INPUTS} inputs per job`);
      if (req.workload === "embeddings" && (!req.model || !req.modelDigest))
        throw new Error("Embeddings need a model and modelDigest");
      const mode =
        req.mode.kind === "private"
          ? { kind: "private" as const, pool_id: req.mode.poolId }
          : req.mode.kind === "collective"
            ? { kind: "collective" as const, project_id: req.mode.projectId }
            : {
                kind: "paid_usdc" as const,
                max_cost_microusdc: toMicroUsdc(req.mode.maxCostUsdc),
                operator: await pickPaidOperator(),
              };
      const workload =
        req.workload === "sha256"
          ? { kind: "sha256" as const, texts: req.inputs }
          : {
              kind: "embeddings" as const,
              model: req.model,
              model_digest: req.modelDigest,
              texts: req.inputs,
            };
      const job = await opts.client.request<SoapboxJob>("POST", "/v1/jobs", {
        idempotency_key: req.idempotencyKey,
        mode,
        workload,
        resources: DEFAULT_RESOURCES[req.workload],
      });
      return { id: job.id, status: job.status };
    },
    async cancel(id) {
      try {
        const job = await opts.client.request<SoapboxJob>(
          "POST",
          `/v1/jobs/${encodeURIComponent(id)}/cancel`,
          {},
        );
        return { ok: true, status: job.status };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async quote(id) {
      const job = await getJob(id);
      if (!job || job.status !== "awaiting_payment" || !job.payment) return null;
      return quoteFromPayment(job.id, job.payment);
    },
    async fund(req: ComputeFundRequest): Promise<ComputeFundResult> {
      const key = req.idempotencyKey;
      const running = fundings.get(key);
      if (running) return running;
      const attempt = fundOnce(req);
      fundings.set(key, attempt);
      try {
        return await attempt;
      } finally {
        // A failed attempt may be retried with a fresh token; a funded one is
        // guarded by the ledger's already_funded check upstream.
        fundings.delete(key);
      }
    },
    async pauseWorker(workerId, paused) {
      try {
        const res = await opts.client.request<{ paused?: boolean }>(
          "POST",
          `/v1/workers/${encodeURIComponent(workerId)}/pause`,
          { paused },
        );
        return { ok: true, paused: res?.paused ?? paused };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  async function fundOnce(req: ComputeFundRequest): Promise<ComputeFundResult> {
    if (opts.role === "operator") throw new Error("Operator nodes cannot fund buyer jobs");
    // The signer's own check, consuming the token: good for one transaction.
    const verified = verifyComputeApprovalToken(req.approvalToken, {
      jobId: req.jobId,
      quoteHash: req.quoteHash,
      now: now(),
      consume: true,
    });
    if (!verified.ok) throw new Error(`Approval token refused: ${verified.reason}`);
    const job = await getJob(req.jobId);
    if (!job || job.status !== "awaiting_payment" || !job.payment)
      throw new Error("Job is not awaiting USDC funding");
    const quote = quoteFromPayment(job.id, job.payment);
    if (quote.quoteHash !== req.quoteHash)
      throw new Error("Coordinator quote changed since approval");
    if (toMicroUsdc(req.amountUsdc) !== job.payment.amount_microusdc)
      throw new Error("Approved amount does not match the quote");
    const funder: SoapboxFunder =
      opts.funder ?? ((payment) => fundApprovedSoapboxQuote(opts.mainWallet, payment));
    const funding = await funder(job.payment);
    let status = funding.status;
    try {
      const updated = await opts.client.request<SoapboxJob>(
        "POST",
        `/v1/jobs/${encodeURIComponent(job.id)}/payment`,
        {},
      );
      status = updated.status;
    } catch (err) {
      log.warn(
        `funded ${job.id} but the coordinator did not refresh its payment state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { txHash: funding.txHash ?? "", status };
  }

  return backend;
}

/**
 * Register the adapter as the node's compute backend and, unless compute is
 * disabled, start the delivery store and watcher so the `compute` tool can
 * submit and the agent is woken on completions. Idempotent per plugin load;
 * the registered service tears everything down on stop.
 */
export function attachComputeAwareness(
  api: Pick<BitterbotPluginApi, "config" | "logger" | "registerService">,
  params: { client: SoapboxBackendClient; role?: "buyer" | "operator" },
): ComputeBackend {
  const backend = createSoapboxComputeBackend({
    client: params.client,
    config: api.config,
    role: params.role,
    mainWallet: api.config.tools?.wallet,
  });
  registerComputeBackend(backend);
  const enabled = api.config.compute?.enabled !== false;
  let store: ComputeDeliveryStore | null = null;
  let watcher: ComputeWatcher | null = null;
  api.registerService({
    id: "compute-awareness",
    start() {
      if (!enabled) return;
      try {
        store = ComputeDeliveryStore.open();
        watcher = startComputeWatcher({
          backend,
          store,
          ownerSessionKey: () => resolveMainSessionKey(api.config),
          wakeBudgetPerHour: api.config.compute?.awareness?.wakeBudgetPerHour,
          nudges: api.config.compute?.awareness?.nudges !== false,
        });
        registerComputeRuntime({ store, watcher });
        api.logger.info("compute awareness active: backend, delivery store and watcher registered");
      } catch (err) {
        api.logger.warn(
          `compute awareness runtime unavailable (tool stays read-only): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    stop() {
      registerComputeRuntime(null);
      watcher?.stop();
      watcher = null;
      try {
        store?.close();
      } catch {
        // closing twice or on a failed open is harmless
      }
      store = null;
      registerComputeBackend(null);
    },
  });
  return backend;
}
