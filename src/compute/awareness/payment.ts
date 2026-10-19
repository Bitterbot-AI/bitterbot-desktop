/**
 * PLAN-57 §4.8: payment authority for paid compute, outside the model and
 * enforced at the signer.
 *
 * Omitting a funding tool is necessary, not proof. The proof is structural:
 *
 * - The only way a compute backend's `fund()` is ever called is
 *   `approveComputeFunding` below, and it runs inside the spend gate
 *   (`gatedWallet`, origin `rpc`), so the decision is recorded with every
 *   other outbound payment.
 * - `approveComputeFunding` first mints an approval token bound to the job,
 *   the exact quote hash, the deciding connection's scopes, the surface that
 *   decided and a short expiry. Minting refuses agent-origin requests, chat
 *   replies, connections without the owner's approval scope, a disabled
 *   paid path and anything over the caps. Every refusal is logged, written
 *   to the compute ledger and counted.
 * - The token is HMAC-signed with a per-process secret and single use. Core
 *   checks it without consuming it; the backend's signer (`fundSoapbox`,
 *   which runs in this process as part of the plugin) calls
 *   `verifyComputeApprovalToken` itself before building a transaction, and
 *   that call consumes the token. A signer in another process cannot verify
 *   it, by design: funding authority never leaves the gateway process.
 * - Funding is serialised per job (an in-flight lock plus a `pending` ledger
 *   row), refused outright when the ledger is unavailable, and bound to the
 *   quote hash the approver looked at.
 *
 * The two surfaces that mint are the `compute.approve` gateway method (an
 * authenticated admin connection: `bitterbot compute approve` or a Control UI
 * client) and the review executor for a hold the agent's paid `submit`
 * created, which carries the scopes and connection mode of the connection
 * that resolved it. A backend-mode (internal) connection and a chat reply are
 * refused whatever their scopes. The agent's own tool has no action that
 * reaches this module.
 */

import crypto from "node:crypto";
import type { BitterbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { recordConsideration } from "../../infra/heartbeat-considerations.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { gatedWallet } from "../../review/spend.js";
import type { WalletService } from "../../services/wallet-service.js";
import {
  type ComputeBackend,
  type ComputeFundRequest,
  type ComputeQuote,
  getComputeBackend,
} from "./backend.js";
import type { ComputeLedger } from "./ledger.js";
import { getComputeRuntime } from "./runtime.js";

const log = createSubsystemLogger("compute/payment");

/** Scopes that stand for the owner on a gateway connection. */
export const COMPUTE_FUNDING_SCOPES = ["operator.admin", "operator.approvals"] as const;
export const COMPUTE_APPROVAL_TOKEN_TTL_MS = 5 * 60_000;
export const DEFAULT_MAX_USDC_PER_JOB = 5;
export const DEFAULT_MAX_USDC_PER_DAY = 20;
/** A `pending` ledger row older than this no longer blocks a new attempt. */
export const COMPUTE_FUNDING_PENDING_WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Gateway client mode of the node's own internal connections (callGateway from inside the gateway). */
const INTERNAL_CONNECTION_MODE = "backend";

/** Who is asking for money to move, as the signer sees it. */
export type FundingAuthority = {
  /** `owner`: an authenticated gateway connection. `agent`: a tool call. `internal`: the node itself. */
  origin: "owner" | "agent" | "internal";
  /** The connection's scopes; must include one of COMPUTE_FUNDING_SCOPES. */
  scopes: ReadonlyArray<string>;
  /** The surface that decided, as the caller labelled it: control-ui, cli, gateway, chat... A chat reply never funds. */
  via: string;
  /**
   * The deciding gateway connection's client mode (cli, ui, webchat,
   * backend...). This is the connection's own property, not a label the
   * caller chose: a `backend` (internal) connection never funds, whatever
   * `via` says and whatever scopes the internal client carries.
   */
  connectionMode?: string | null;
  decidedBy: string;
  /** The review row the approval came from, when it came from one. */
  reviewId?: string | null;
};

export type ComputeApprovalClaims = {
  v: 1;
  job: string;
  quote: string;
  /** Amount in micro-USDC. */
  amt: number;
  rid: string | null;
  by: string;
  via: string;
  /** Scopes of the deciding connection, as checked at mint. */
  scp: string[];
  iat: number;
  exp: number;
  nonce: string;
};

export type MintRefusal =
  | "agent_origin"
  | "internal_origin"
  | "internal_connection"
  | "chat_decision"
  | "missing_scope"
  | "paid_disabled"
  | "invalid_quote"
  | "over_cap"
  | "over_daily_cap";

export type MintResult =
  | { ok: true; token: string; expiresAt: number; claims: ComputeApprovalClaims }
  | { ok: false; reason: MintRefusal; message: string };

export type VerifyRefusal =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "job_mismatch"
  | "quote_mismatch"
  | "consumed";

export type VerifyResult =
  | { ok: true; claims: ComputeApprovalClaims }
  | { ok: false; reason: VerifyRefusal };

let secret: Buffer | null = null;
/** Consumed token nonces with their expiry, pruned as they expire. */
const consumedNonces = new Map<string, number>();
/** Fundings in flight, one per job; a second caller is refused, not queued. */
const inFlight = new Map<string, Promise<ApproveComputeFundingResult>>();
const counters = { minted: 0, mintRefused: 0, verified: 0, verifyRefused: 0, funded: 0 };

function tokenSecret(): Buffer {
  secret ??= crypto.randomBytes(32);
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
}

export function toMicroUsdc(amountUsdc: number): number {
  return Math.round(amountUsdc * 1_000_000);
}

/** The hash an approval is bound to: job, exact amount, payee and network. */
export function computeQuoteHash(q: {
  jobId: string;
  amountUsdc: number;
  payee: string;
  network?: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      `${q.jobId}|${toMicroUsdc(q.amountUsdc)}|${q.payee.trim().toLowerCase()}|${q.network ?? ""}`,
    )
    .digest("hex");
}

/** For tests and the doctor: how often the signer was asked and how often it said no. */
export function computePaymentCounters(): Readonly<typeof counters> {
  return { ...counters };
}

export function resetComputePaymentForTest(): void {
  secret = null;
  consumedNonces.clear();
  inFlight.clear();
  for (const k of Object.keys(counters) as Array<keyof typeof counters>) {
    counters[k] = 0;
  }
}

function paidConfig(cfg: BitterbotConfig | undefined) {
  const paid = cfg?.compute?.paid;
  return {
    enabled: paid?.enabled === true,
    maxPerJob: paid?.maxUsdcPerJob ?? DEFAULT_MAX_USDC_PER_JOB,
    maxPerDay: paid?.maxUsdcPerDay ?? DEFAULT_MAX_USDC_PER_DAY,
  };
}

function hasFundingScope(scopes: ReadonlyArray<string>): boolean {
  return COMPUTE_FUNDING_SCOPES.some((s) => scopes.includes(s));
}

/**
 * Mint an approval token. Refuses anything that is not an authenticated owner
 * decision for an exact quote inside the caps; refusals are counted here and
 * recorded by the caller.
 */
export function mintComputeApprovalToken(params: {
  quote: ComputeQuote;
  authority: FundingAuthority;
  config?: BitterbotConfig;
  /** USDC already funded in the last 24 hours, for the daily cap. */
  fundedTodayUsdc?: number;
  now?: number;
  ttlMs?: number;
}): MintResult {
  const refuse = (reason: MintRefusal, message: string): MintResult => {
    counters.mintRefused += 1;
    return { ok: false, reason, message };
  };
  const { quote, authority } = params;
  if (authority.origin === "agent") {
    return refuse(
      "agent_origin",
      "Agent-originated requests never receive an approval token. The owner approves paid compute in the Control UI or with `bitterbot compute approve <job>`.",
    );
  }
  if (authority.origin === "internal") {
    return refuse("internal_origin", "The node does not fund compute for itself.");
  }
  if (authority.via.trim().toLowerCase() === "chat") {
    return refuse(
      "chat_decision",
      "A chat reply is not an authenticated owner session for payments. Approve this one in the Control UI or with `bitterbot compute approve <job>`.",
    );
  }
  if ((authority.connectionMode ?? "").trim().toLowerCase() === INTERNAL_CONNECTION_MODE) {
    return refuse(
      "internal_connection",
      "The decision came through the node's own internal connection, not from the owner. Approve this one in the Control UI or with `bitterbot compute approve <job>`.",
    );
  }
  if (!hasFundingScope(authority.scopes)) {
    return refuse(
      "missing_scope",
      `The connection that approved this does not hold ${COMPUTE_FUNDING_SCOPES.join(" or ")}.`,
    );
  }
  const cfg = paidConfig(params.config ?? safeLoadConfig());
  if (!cfg.enabled) {
    return refuse("paid_disabled", "Paid compute is off (compute.paid.enabled).");
  }
  const amount = quote.amountUsdc;
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    quote.payee.trim().length === 0 ||
    quote.jobId.trim().length === 0 ||
    computeQuoteHash(quote) !== quote.quoteHash
  ) {
    return refuse(
      "invalid_quote",
      "The quote is incomplete or its hash does not match its fields.",
    );
  }
  if (amount > cfg.maxPerJob) {
    return refuse(
      "over_cap",
      `${amount} USDC is above the per-job cap of ${cfg.maxPerJob} USDC (compute.paid.maxUsdcPerJob).`,
    );
  }
  const today = params.fundedTodayUsdc ?? 0;
  if (today + amount > cfg.maxPerDay) {
    return refuse(
      "over_daily_cap",
      `${amount} USDC would take the last 24 hours to ${round6(today + amount)} USDC, above the daily cap of ${cfg.maxPerDay} USDC (compute.paid.maxUsdcPerDay).`,
    );
  }
  const now = params.now ?? Date.now();
  const claims: ComputeApprovalClaims = {
    v: 1,
    job: quote.jobId,
    quote: quote.quoteHash,
    amt: toMicroUsdc(amount),
    rid: authority.reviewId ?? null,
    by: authority.decidedBy.slice(0, 120),
    via: authority.via.slice(0, 40),
    scp: [...authority.scopes].slice(0, 8),
    iat: now,
    exp: now + (params.ttlMs ?? COMPUTE_APPROVAL_TOKEN_TTL_MS),
    nonce: crypto.randomBytes(12).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  counters.minted += 1;
  return { ok: true, token: `${payload}.${sign(payload)}`, expiresAt: claims.exp, claims };
}

/**
 * The signer's check. A backend's `fund()` must call this before building a
 * transaction; that call consumes the token (`consume` defaults to true).
 * Core's own check before `fund()` passes `consume: false`, so the signer
 * sees a fresh token exactly once.
 */
export function verifyComputeApprovalToken(
  token: string | null | undefined,
  expected: { jobId: string; quoteHash: string; now?: number; consume?: boolean },
): VerifyResult {
  const refuse = (reason: VerifyRefusal): VerifyResult => {
    counters.verifyRefused += 1;
    return { ok: false, reason };
  };
  if (typeof token !== "string" || token.length === 0) {
    return refuse("missing");
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return refuse("malformed");
  }
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = sign(payload);
  if (
    sig.length !== want.length ||
    !crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(want, "utf8"))
  ) {
    return refuse("bad_signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return refuse("malformed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return refuse("malformed");
  }
  const claims = parsed as ComputeApprovalClaims;
  if (
    claims.v !== 1 ||
    typeof claims.job !== "string" ||
    typeof claims.quote !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.nonce !== "string"
  ) {
    return refuse("malformed");
  }
  const now = expected.now ?? Date.now();
  pruneConsumed(now);
  if (now >= claims.exp) {
    return refuse("expired");
  }
  if (claims.job !== expected.jobId) {
    return refuse("job_mismatch");
  }
  if (claims.quote !== expected.quoteHash) {
    return refuse("quote_mismatch");
  }
  if (consumedNonces.has(claims.nonce)) {
    return refuse("consumed");
  }
  if (expected.consume !== false) {
    consumedNonces.set(claims.nonce, claims.exp);
  }
  counters.verified += 1;
  return { ok: true, claims };
}

function pruneConsumed(now: number): void {
  for (const [nonce, exp] of consumedNonces) {
    if (exp <= now) {
      consumedNonces.delete(nonce);
    }
  }
}

export type ApproveComputeFundingParams = {
  jobId: string;
  authority: FundingAuthority;
  /**
   * The quote hash the approval was given for (the one on a review row). The
   * funding is refused if the coordinator quotes something else now.
   */
  expectedQuoteHash?: string | null;
  config?: BitterbotConfig;
  backend?: ComputeBackend | null;
  ledger?: ComputeLedger | null;
  now?: number;
};

export type ApproveComputeFundingResult =
  | {
      ok: true;
      jobId: string;
      amountUsdc: number;
      payee: string;
      quoteHash: string;
      txHash: string;
      status: string;
    }
  | {
      ok: false;
      jobId: string;
      reason: string;
      message: string;
      amountUsdc?: number;
      payee?: string;
      quoteHash?: string;
    };

/**
 * The one path from an approval to a funded job. Quote, mint, verify, fund
 * through the spend gate, record. Every exit is written to the ledger, and
 * one job is funded by one caller at a time.
 */
export async function approveComputeFunding(
  params: ApproveComputeFundingParams,
): Promise<ApproveComputeFundingResult> {
  const jobId = params.jobId.trim();
  const running = jobId ? inFlight.get(jobId) : undefined;
  if (running) {
    return refuseInFlight(params, jobId);
  }
  const attempt = approveComputeFundingOnce(params, jobId);
  if (jobId) {
    inFlight.set(jobId, attempt);
  }
  try {
    return await attempt;
  } finally {
    if (jobId && inFlight.get(jobId) === attempt) {
      inFlight.delete(jobId);
    }
  }
}

function refuseInFlight(
  params: ApproveComputeFundingParams,
  jobId: string,
): ApproveComputeFundingResult {
  const ledger = params.ledger === undefined ? safeLedger() : params.ledger;
  try {
    ledger?.recordPayment({
      ts: params.now ?? Date.now(),
      jobId,
      quoteHash: params.expectedQuoteHash ?? null,
      amountUsdc: 0,
      payee: null,
      outcome: "refused",
      reason: "in_progress",
      reviewId: params.authority.reviewId ?? null,
      decidedBy: params.authority.decidedBy,
      via: params.authority.via,
      txHash: null,
    });
  } catch {
    // Recorded on a best-effort basis; the refusal stands either way.
  }
  log.warn(`compute funding refused for ${jobId}: in_progress (another approval is funding it)`);
  return {
    ok: false,
    jobId,
    reason: "in_progress",
    message: "Another approval is funding this job right now; wait for it to finish.",
  };
}

async function approveComputeFundingOnce(
  params: ApproveComputeFundingParams,
  jobId: string,
): Promise<ApproveComputeFundingResult> {
  const now = params.now ?? Date.now();
  const backend = params.backend === undefined ? getComputeBackend() : params.backend;
  const ledger = params.ledger === undefined ? safeLedger() : params.ledger;
  const authority = params.authority;

  const record = (
    outcome: "pending" | "funded" | "failed" | "refused",
    detail: {
      reason?: string;
      quote?: ComputeQuote | null;
      txHash?: string;
      amountUsdc?: number;
    },
  ) => {
    try {
      ledger?.recordPayment({
        ts: now,
        jobId,
        quoteHash: detail.quote?.quoteHash ?? null,
        amountUsdc: detail.amountUsdc ?? detail.quote?.amountUsdc ?? 0,
        payee: detail.quote?.payee ?? null,
        outcome,
        reason: detail.reason ?? null,
        reviewId: authority.reviewId ?? null,
        decidedBy: authority.decidedBy,
        via: authority.via,
        txHash: detail.txHash ?? null,
      });
    } catch (err) {
      log.warn(`could not record compute payment event for ${jobId}: ${String(err)}`);
    }
    if (outcome === "pending") {
      return;
    }
    try {
      recordConsideration({
        category: "compute-payment",
        subject: `compute job ${jobId}`,
        decision: outcome === "funded" ? "acted" : "blocked",
        reason: detail.reason ?? outcome,
        payload: {
          origin: authority.origin,
          via: authority.via,
          amountUsdc: detail.amountUsdc ?? detail.quote?.amountUsdc ?? null,
          ...(detail.txHash ? { txHash: detail.txHash } : {}),
        },
      });
    } catch {
      // Considerations are an after-the-fact log; never block a payment path on them.
    }
  };
  const refuse = (
    reason: string,
    message: string,
    quote?: ComputeQuote | null,
  ): ApproveComputeFundingResult => {
    record("refused", { reason, quote });
    log.warn(
      `compute funding refused for ${jobId}: ${reason} (origin=${authority.origin}, via=${authority.via}, by=${authority.decidedBy})`,
    );
    return {
      ok: false,
      jobId,
      reason,
      message,
      ...(quote
        ? { amountUsdc: quote.amountUsdc, payee: quote.payee, quoteHash: quote.quoteHash }
        : {}),
    };
  };

  if (!jobId) {
    return refuse("invalid_job", "A job id is required.");
  }
  if (!backend || typeof backend.quote !== "function" || typeof backend.fund !== "function") {
    return refuse("unsupported", "This node's compute backend does not fund paid jobs.");
  }
  // Without the ledger there is no already-funded guard and no daily cap, so
  // nothing is funded: the owner sees the refusal, not a silent cap bypass.
  if (!ledger) {
    return refuse(
      "ledger_unavailable",
      "The compute payment ledger is not available on this node (the compute runtime is not registered); nothing is funded without it.",
    );
  }
  // Agent and internal origins are refused before anything is fetched, so a
  // misrouted call cannot even learn the quote through this path.
  if (authority.origin !== "owner") {
    const minted = mintComputeApprovalToken({
      quote: { jobId, amountUsdc: 0, payee: "", quoteHash: "" },
      authority,
      config: params.config,
      now,
    });
    const reason = minted.ok ? "agent_origin" : minted.reason;
    return refuse(reason, minted.ok ? "refused" : minted.message);
  }

  let quote: ComputeQuote | null;
  try {
    quote = await backend.quote(jobId);
  } catch (err) {
    return refuse("quote_failed", `The coordinator could not quote the job: ${errorText(err)}`);
  }
  if (!quote) {
    return refuse("no_quote", "The job is not waiting for payment.");
  }
  if (params.expectedQuoteHash && params.expectedQuoteHash !== quote.quoteHash) {
    return refuse(
      "quote_changed",
      `The coordinator now quotes ${quote.amountUsdc} USDC to ${quote.payee}, not what was approved. Look at the new quote and approve it again if it is right.`,
      quote,
    );
  }
  if (quote.expiresAt !== undefined && now >= quote.expiresAt) {
    return refuse(
      "quote_expired",
      "The coordinator's quote has expired; ask for a new one.",
      quote,
    );
  }
  const already = ledger.fundedTxFor(jobId);
  if (already) {
    return refuse("already_funded", `This job was already funded (transaction ${already}).`, quote);
  }
  const latest = ledger.latestPaymentFor(jobId);
  if (latest?.outcome === "pending" && now - latest.ts < COMPUTE_FUNDING_PENDING_WINDOW_MS) {
    return refuse(
      "in_progress",
      "A funding for this job was started and has not been settled yet; wait before trying again.",
      quote,
    );
  }

  const minted = mintComputeApprovalToken({
    quote,
    authority,
    config: params.config,
    fundedTodayUsdc: ledger.fundedUsdcSince(now - DAY_MS),
    now,
  });
  if (!minted.ok) {
    return refuse(minted.reason, minted.message, quote);
  }
  // Core checks the token without consuming it; the backend's signer is the
  // consumer, so it sees a fresh token exactly once.
  const verified = verifyComputeApprovalToken(minted.token, {
    jobId,
    quoteHash: quote.quoteHash,
    now,
    consume: false,
  });
  if (!verified.ok) {
    return refuse(`bad_token:${verified.reason}`, "The approval token did not verify.", quote);
  }

  const fundReq: ComputeFundRequest = {
    jobId,
    quoteHash: quote.quoteHash,
    amountUsdc: quote.amountUsdc,
    approvalToken: minted.token,
    idempotencyKey: `compute-fund:${jobId}:${quote.quoteHash.slice(0, 16)}`,
  };
  // The owner's approval still goes through the spend gate, so it is
  // recorded beside every other outbound payment. A `pending` row goes down
  // first: if the process dies mid-funding, the job is blocked for a while
  // instead of being funded twice.
  record("pending", { quote });
  const gated = gatedWallet(fundingWallet(backend, fundReq, quote), {
    origin: "rpc",
    purpose: `compute job ${jobId} escrow (${authority.via}, ${authority.reviewId ?? "direct"})`,
  });
  try {
    const sent = await gated.sendUsdc(quote.payee, quote.amountUsdc);
    counters.funded += 1;
    record("funded", { quote, txHash: sent.txHash });
    log.info(
      `compute job ${jobId} funded: ${quote.amountUsdc} USDC to ${quote.payee}, tx ${sent.txHash} (by ${authority.decidedBy} via ${authority.via})`,
    );
    return {
      ok: true,
      jobId,
      amountUsdc: quote.amountUsdc,
      payee: quote.payee,
      quoteHash: quote.quoteHash,
      txHash: sent.txHash,
      status: sent.status,
    };
  } catch (err) {
    const message = errorText(err);
    record("failed", { quote, reason: message.slice(0, 120) });
    log.warn(`compute job ${jobId} funding failed: ${message}`);
    return {
      ok: false,
      jobId,
      reason: "fund_failed",
      message: `Funding failed: ${message}`,
      amountUsdc: quote.amountUsdc,
      payee: quote.payee,
      quoteHash: quote.quoteHash,
    };
  }
}

/**
 * A wallet-shaped view of the backend's `fund()`, so the spend gate can wrap
 * it. Only `sendUsdc` does anything, and only for the quoted payee and amount.
 */
function fundingWallet(
  backend: ComputeBackend,
  req: ComputeFundRequest,
  quote: ComputeQuote,
): WalletService {
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available on the compute funding wallet`);
  };
  return {
    getAddress: unsupported("getAddress"),
    getBalance: unsupported("getBalance"),
    getTransactionHistory: unsupported("getTransactionHistory"),
    getFundingUrl: unsupported("getFundingUrl"),
    getNetwork: () => quote.network ?? "compute",
    payForResource: unsupported("payForResource"),
    getX402PayerAddress: unsupported("getX402PayerAddress"),
    signMessage: unsupported("signMessage"),
    getSmartAccountConfig: () => ({
      enabled: false,
      periodSeconds: 0,
      sponsorGas: false,
      network: quote.network ?? "compute",
    }),
    async sendUsdc(to, amount) {
      if (to !== quote.payee || toMicroUsdc(amount) !== toMicroUsdc(quote.amountUsdc)) {
        throw new Error("the funding request does not match the quote");
      }
      if (!backend.fund) {
        throw new Error("the compute backend cannot fund jobs");
      }
      return await backend.fund(req);
    },
  };
}

function safeLoadConfig(): BitterbotConfig | undefined {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}

function safeLedger(): ComputeLedger | null {
  try {
    return getComputeRuntime()?.store.ledger() ?? null;
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
