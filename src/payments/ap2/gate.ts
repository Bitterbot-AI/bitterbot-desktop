/**
 * The spend gate (PLAN-53 C0): the one way money leaves this node.
 *
 * Every outbound payment goes through a wallet wrapped by `gateWallet`,
 * whichever route asked for it: the agent's wallet tool, a paid task sent to
 * another agent, the gateway's own RPC, or an automatic payout. Before this,
 * the owner's approval covered only the wallet tool inside an agent turn, the
 * "session" cap restarted with every run, and nothing recorded why an
 * outbound payment was allowed.
 *
 * The gate decides, the wallet service underneath still enforces the
 * per-transaction and rolling 24-hour limits, and every decision is written
 * down, including the ones that were refused.
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  SendResult,
  SendUsdcOptions,
  WalletService,
  X402PaymentResult,
} from "../../services/wallet-service.js";

const log = createSubsystemLogger("payments/gate");

/** Which route asked for the payment. */
export type SpendOrigin =
  /** The agent's wallet tool. The review stage has already run (or it was approved). */
  | "wallet-tool"
  /** A paid task sent to another agent. */
  | "a2a"
  /** The owner acting directly through the gateway RPC. */
  | "rpc"
  /** Money already owed to someone else: royalties, bounties, stream checks. */
  | "payout";

export type SpendContext = {
  origin: SpendOrigin;
  /** The session the spend is for, when there is one. Session caps key on it. */
  sessionKey?: string;
  agentId?: string;
  /** Most this session may spend in 24 hours. Absent means no session cap. */
  sessionCapUsd?: number;
  /** What it is for, for the record. */
  purpose?: string;
  /**
   * Ask the owner. Called when a spend needs approval it does not have;
   * returns the message for the caller, who is refused for now.
   */
  requestApproval?: (spend: { payee: string; amountUsd: number }) => string;
  /** Whether the owner's approval is needed for this origin (review.spend). */
  approvalRequired?: boolean;
};

export type SpendDecision = {
  id: string;
  ts: number;
  origin: SpendOrigin;
  rail: "usdc" | "x402" | "card";
  payee: string;
  amountUsd: number;
  verdict: "allow" | "deny";
  /** Why: "approved by the owner", "session cap", "standing grant grant-1"... */
  reason: string;
  /** What then happened to an allowed spend. */
  outcome: "sent" | "failed" | "refused";
  txHash?: string;
  error?: string;
  sessionKey?: string;
  purpose?: string;
};

export type GateDeps = {
  /** Keep the decision. Must not throw; a record never blocks a payment. */
  record: (decision: SpendDecision) => void;
  /** True inside the execution of something the owner approved. */
  isApproved: () => boolean;
  now: () => number;
};

const DAY_MS = 24 * 60 * 60_000;

/** What each session has spent, kept for 24 hours. In memory, per process. */
const sessionSpend = new Map<string, Array<{ at: number; usd: number }>>();

export function sessionSpentUsd(sessionKey: string, now = Date.now()): number {
  const rows = (sessionSpend.get(sessionKey) ?? []).filter((r) => now - r.at < DAY_MS);
  if (rows.length === 0) {
    sessionSpend.delete(sessionKey);
    return 0;
  }
  sessionSpend.set(sessionKey, rows);
  return rows.reduce((sum, r) => sum + r.usd, 0);
}

function addSessionSpend(sessionKey: string, usd: number, now: number): void {
  addSessionRow(sessionKey, { at: now, usd });
}

/**
 * Count `usd` against the session now, while the payment is in flight, so
 * concurrent payments in one session can't all pass the cap. Settle it at what
 * was actually charged, or release it if nothing was.
 */
function holdSessionSpend(
  sessionKey: string | undefined,
  usd: number,
  now: number,
): { settle: (chargedUsd: number) => void; release: () => void } {
  if (!sessionKey) {
    return { settle: () => {}, release: () => {} };
  }
  const row = { at: now, usd };
  addSessionRow(sessionKey, row);
  return {
    settle: (chargedUsd) => {
      row.usd = chargedUsd;
    },
    release: () => {
      const rows = sessionSpend.get(sessionKey);
      const i = rows?.indexOf(row) ?? -1;
      if (rows && i >= 0) {
        rows.splice(i, 1);
      }
    },
  };
}

function addSessionRow(sessionKey: string, row: { at: number; usd: number }): void {
  const rows = sessionSpend.get(sessionKey) ?? [];
  rows.push(row);
  sessionSpend.set(sessionKey, rows);
}

export class SpendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendRefusedError";
  }
}

let defaultDeps: GateDeps | null = null;

/** The gateway installs where decisions go and how approval is recognised. */
export function configureSpendGate(deps: Partial<GateDeps> | null): void {
  defaultDeps = deps
    ? {
        record: deps.record ?? (() => {}),
        isApproved: deps.isApproved ?? (() => false),
        now: deps.now ?? Date.now,
      }
    : null;
}

function resolveDeps(overrides?: Partial<GateDeps>): GateDeps {
  return {
    record: overrides?.record ?? defaultDeps?.record ?? (() => {}),
    isApproved: overrides?.isApproved ?? defaultDeps?.isApproved ?? (() => false),
    now: overrides?.now ?? defaultDeps?.now ?? Date.now,
  };
}

type Authorization = { ok: true; reason: string } | { ok: false; reason: string; message: string };

function authorize(
  ctx: SpendContext,
  spend: { payee: string; amountUsd: number; grantRef?: string },
  deps: GateDeps,
): Authorization {
  const { amountUsd } = spend;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return {
      ok: false,
      reason: "invalid amount",
      message: "The amount must be a positive number.",
    };
  }
  if (ctx.sessionKey && typeof ctx.sessionCapUsd === "number") {
    const spent = sessionSpentUsd(ctx.sessionKey, deps.now());
    if (spent + amountUsd > ctx.sessionCapUsd) {
      return {
        ok: false,
        reason: "session cap",
        message:
          `Session spend cap exceeded. Cap: $${ctx.sessionCapUsd} per 24 hours, spent: $${spent.toFixed(2)}, ` +
          `requested: $${amountUsd.toFixed(2)}. Remaining: $${Math.max(0, ctx.sessionCapUsd - spent).toFixed(2)} ` +
          "(tools.wallet.sessionSpendCapUsd).",
      };
    }
  }
  // The wallet tool is reviewed before it runs, and the owner acting through
  // the RPC is their own approval. A paid task for another agent only learns
  // its price mid-call, so its approval is checked here.
  if (ctx.origin === "a2a" && ctx.approvalRequired) {
    if (deps.isApproved()) {
      return { ok: true, reason: "approved by the owner" };
    }
    if (spend.grantRef) {
      return { ok: true, reason: `standing grant ${spend.grantRef}` };
    }
    const message =
      ctx.requestApproval?.(spend) ??
      "This payment needs the owner's approval and there is no way to ask for it from here.";
    return { ok: false, reason: "needs approval", message };
  }
  if (deps.isApproved()) {
    return { ok: true, reason: "approved by the owner" };
  }
  if (spend.grantRef) {
    return { ok: true, reason: `standing grant ${spend.grantRef}` };
  }
  return {
    ok: true,
    reason:
      ctx.origin === "payout"
        ? "payout of an amount already owed"
        : ctx.origin === "rpc"
          ? "sent by the owner"
          : "passed review",
  };
}

function safeRecord(deps: GateDeps, decision: SpendDecision): void {
  try {
    deps.record(decision);
  } catch (err) {
    log.warn(`could not record spend decision ${decision.id}: ${String(err)}`);
  }
}

export type GatedSendOptions = SendUsdcOptions & {
  /** The standing grant that already covers this spend, if the caller found one. */
  authorizedByGrant?: string;
};

/**
 * Wrap a wallet service so its two paying methods go through the gate.
 * Everything else (balance, address, history, signing) passes straight through.
 */
export function gateWallet(
  wallet: WalletService,
  ctx: SpendContext,
  overrides?: Partial<GateDeps>,
): WalletService {
  const base = (
    rail: "usdc" | "x402" | "card",
    payee: string,
    amountUsd: number,
    deps: GateDeps,
  ) => ({
    id: `sd-${crypto.randomBytes(5).toString("hex")}`,
    ts: deps.now(),
    origin: ctx.origin,
    rail,
    payee,
    amountUsd,
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx.purpose ? { purpose: ctx.purpose.slice(0, 300) } : {}),
  });

  return {
    ...wallet,
    async sendUsdc(to: string, amount: number, opts?: GatedSendOptions): Promise<SendResult> {
      const deps = resolveDeps(overrides);
      const record = base("usdc", to, amount, deps);
      const auth = authorize(
        ctx,
        { payee: to, amountUsd: amount, grantRef: opts?.authorizedByGrant },
        deps,
      );
      if (!auth.ok) {
        safeRecord(deps, { ...record, verdict: "deny", reason: auth.reason, outcome: "refused" });
        throw new SpendRefusedError(auth.message);
      }
      const hold = holdSessionSpend(ctx.sessionKey, amount, deps.now());
      try {
        const result = await wallet.sendUsdc(to, amount, opts);
        hold.settle(amount);
        safeRecord(deps, {
          ...record,
          verdict: "allow",
          reason: auth.reason,
          outcome: "sent",
          txHash: result.txHash,
        });
        return result;
      } catch (err) {
        hold.release();
        safeRecord(deps, {
          ...record,
          verdict: "allow",
          reason: auth.reason,
          outcome: "failed",
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
        throw err;
      }
    },

    async payForResource(resourceUrl: string, amountUsdc: number): Promise<X402PaymentResult> {
      const deps = resolveDeps(overrides);
      const record = base("x402", resourceUrl, amountUsdc, deps);
      const auth = authorize(ctx, { payee: resourceUrl, amountUsd: amountUsdc }, deps);
      if (!auth.ok) {
        safeRecord(deps, { ...record, verdict: "deny", reason: auth.reason, outcome: "refused" });
        return { success: false, error: auth.message };
      }
      const hold = holdSessionSpend(ctx.sessionKey, amountUsdc, deps.now());
      let result: X402PaymentResult;
      try {
        result = await wallet.payForResource(resourceUrl, amountUsdc);
      } catch (err) {
        hold.release();
        throw err;
      }
      const paid = result.success ? (result.amountPaid ?? amountUsdc) : 0;
      if (result.success) {
        hold.settle(paid);
      } else {
        hold.release();
      }
      safeRecord(deps, {
        ...record,
        // What was actually charged, which can be less than what was allowed.
        amountUsd: result.success ? paid : amountUsdc,
        verdict: "allow",
        reason: auth.reason,
        outcome: result.success ? "sent" : "failed",
        ...(result.txHash ? { txHash: result.txHash } : {}),
        ...(result.success ? {} : { error: (result.error ?? "payment failed").slice(0, 300) }),
      });
      return result;
    },
  };
}

/**
 * A card purchase through Link (PLAN-53 C1). The owner approves each one in
 * the Link app, so the gate's part is the session cap and the record. Call it
 * just before the card is used; it throws SpendRefusedError if refused.
 */
export function gateCardPurchase(
  ctx: SpendContext,
  spend: { payee: string; amountUsd: number; requestId: string },
  overrides?: Partial<GateDeps>,
): void {
  const deps = resolveDeps(overrides);
  const record = {
    id: `sd-${crypto.randomBytes(5).toString("hex")}`,
    ts: deps.now(),
    origin: ctx.origin,
    rail: "card" as const,
    payee: spend.payee,
    amountUsd: spend.amountUsd,
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    purpose: `Link spend request ${spend.requestId}${ctx.purpose ? `: ${ctx.purpose.slice(0, 200)}` : ""}`,
  };
  const auth = authorize({ ...ctx, approvalRequired: false }, spend, deps);
  if (!auth.ok) {
    safeRecord(deps, { ...record, verdict: "deny", reason: auth.reason, outcome: "refused" });
    throw new SpendRefusedError(auth.message);
  }
  if (ctx.sessionKey) {
    addSessionSpend(ctx.sessionKey, spend.amountUsd, deps.now());
  }
  safeRecord(deps, { ...record, verdict: "allow", reason: "approved in Link", outcome: "sent" });
}

export function resetSpendGateForTest(): void {
  sessionSpend.clear();
  defaultDeps = null;
}
