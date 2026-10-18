import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return { ...actual, loadConfig: () => ({}) };
});
vi.mock("../../infra/heartbeat-considerations.js", () => ({ recordConsideration: vi.fn() }));

import type { BitterbotConfig } from "../../config/config.js";
import { recordConsideration } from "../../infra/heartbeat-considerations.js";
import { resetSpendGateForTest } from "../../payments/ap2/gate.js";
import { resetReviewServiceForTest } from "../../review/runtime.js";
import { ReviewService } from "../../review/service.js";
import { resetGatedWalletForTest } from "../../review/spend.js";
import { ReviewStore } from "../../review/store.js";
import type { ComputeBackend, ComputeQuote } from "./backend.js";
import { ComputeDeliveryStore } from "./deliveries.js";
import {
  approveComputeFunding,
  computePaymentCounters,
  computeQuoteHash,
  type FundingAuthority,
  mintComputeApprovalToken,
  resetComputePaymentForTest,
  verifyComputeApprovalToken,
} from "./payment.js";

function quote(over: Partial<Omit<ComputeQuote, "quoteHash">> = {}): ComputeQuote {
  const q = { jobId: "j1", amountUsdc: 0.5, payee: "0xOperator", network: "base-sepolia", ...over };
  return { ...q, quoteHash: computeQuoteHash(q) };
}

const owner: FundingAuthority = {
  origin: "owner",
  scopes: ["operator.admin"],
  via: "control-ui",
  decidedBy: "victor",
};

const cfg = {
  compute: { paid: { enabled: true, maxUsdcPerJob: 2, maxUsdcPerDay: 3 } },
} as BitterbotConfig;

const NOW = 1_700_000_000_000;

describe("computeQuoteHash", () => {
  it("binds job, exact amount, payee (case-insensitive) and network", () => {
    const a = computeQuoteHash({ jobId: "j", amountUsdc: 1.5, payee: "0xAB", network: "n" });
    expect(a).toBe(computeQuoteHash({ jobId: "j", amountUsdc: 1.5, payee: "0xab", network: "n" }));
    expect(a).not.toBe(
      computeQuoteHash({ jobId: "j", amountUsdc: 1.500001, payee: "0xab", network: "n" }),
    );
    expect(a).not.toBe(
      computeQuoteHash({ jobId: "j2", amountUsdc: 1.5, payee: "0xab", network: "n" }),
    );
    expect(a).not.toBe(
      computeQuoteHash({ jobId: "j", amountUsdc: 1.5, payee: "0xcd", network: "n" }),
    );
    expect(a).not.toBe(computeQuoteHash({ jobId: "j", amountUsdc: 1.5, payee: "0xab" }));
  });
});

describe("mintComputeApprovalToken", () => {
  beforeEach(() => resetComputePaymentForTest());

  it("mints for an authenticated owner decision inside the caps", () => {
    const r = mintComputeApprovalToken({ quote: quote(), authority: owner, config: cfg, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.token.split(".")).toHaveLength(2);
      expect(r.claims).toMatchObject({ job: "j1", amt: 500_000, via: "control-ui", by: "victor" });
      expect(r.expiresAt).toBe(NOW + 5 * 60_000);
    }
    expect(computePaymentCounters().minted).toBe(1);
  });

  it.each([
    ["agent_origin", { ...owner, origin: "agent" as const }, cfg],
    ["internal_origin", { ...owner, origin: "internal" as const }, cfg],
    ["chat_decision", { ...owner, via: "chat" }, cfg],
    ["internal_connection", { ...owner, connectionMode: "backend" }, cfg],
    ["missing_scope", { ...owner, scopes: ["operator.read", "operator.write"] }, cfg],
    ["paid_disabled", owner, { compute: { paid: { enabled: false } } } as BitterbotConfig],
    ["paid_disabled", owner, {} as BitterbotConfig],
  ])("refuses %s", (reason, authority, config) => {
    const r = mintComputeApprovalToken({ quote: quote(), authority, config, now: NOW });
    expect(r).toMatchObject({ ok: false, reason });
    expect(computePaymentCounters()).toMatchObject({ minted: 0, mintRefused: 1 });
  });

  it("refuses an agent origin even with every scope and the approvals surface", () => {
    const r = mintComputeApprovalToken({
      quote: quote(),
      authority: {
        origin: "agent",
        scopes: ["operator.admin", "operator.approvals"],
        via: "control-ui",
        decidedBy: "owner",
      },
      config: cfg,
    });
    expect(r).toMatchObject({ ok: false, reason: "agent_origin" });
  });

  it("refuses a quote whose hash does not match its fields, and quotes over the caps", () => {
    const tampered = { ...quote(), amountUsdc: 0.1 };
    expect(
      mintComputeApprovalToken({ quote: tampered, authority: owner, config: cfg }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_quote",
    });
    expect(
      mintComputeApprovalToken({
        quote: quote({ amountUsdc: 2.5 }),
        authority: owner,
        config: cfg,
      }),
    ).toMatchObject({ ok: false, reason: "over_cap" });
    expect(
      mintComputeApprovalToken({
        quote: quote({ amountUsdc: 1 }),
        authority: owner,
        config: cfg,
        fundedTodayUsdc: 2.5,
      }),
    ).toMatchObject({ ok: false, reason: "over_daily_cap" });
    expect(
      mintComputeApprovalToken({ quote: quote({ amountUsdc: 0 }), authority: owner, config: cfg }),
    ).toMatchObject({ ok: false, reason: "invalid_quote" });
  });
});

describe("verifyComputeApprovalToken", () => {
  beforeEach(() => resetComputePaymentForTest());

  function minted() {
    const r = mintComputeApprovalToken({ quote: quote(), authority: owner, config: cfg, now: NOW });
    if (!r.ok) {
      throw new Error(r.message);
    }
    return r;
  }

  it("accepts the token once for its own job and quote", () => {
    const { token } = minted();
    const q = quote();
    const first = verifyComputeApprovalToken(token, {
      jobId: q.jobId,
      quoteHash: q.quoteHash,
      now: NOW,
    });
    expect(first.ok).toBe(true);
    const again = verifyComputeApprovalToken(token, {
      jobId: q.jobId,
      quoteHash: q.quoteHash,
      now: NOW,
    });
    expect(again).toEqual({ ok: false, reason: "consumed" });
  });

  it("can check without consuming", () => {
    const { token } = minted();
    const q = quote();
    const peek = { jobId: q.jobId, quoteHash: q.quoteHash, now: NOW, consume: false };
    expect(verifyComputeApprovalToken(token, peek).ok).toBe(true);
    expect(verifyComputeApprovalToken(token, peek).ok).toBe(true);
  });

  it("refuses missing, malformed, tampered, expired and mismatched tokens", () => {
    const { token } = minted();
    const q = quote();
    const exp = { jobId: q.jobId, quoteHash: q.quoteHash, now: NOW };
    expect(verifyComputeApprovalToken(null, exp)).toEqual({ ok: false, reason: "missing" });
    expect(verifyComputeApprovalToken("", exp)).toEqual({ ok: false, reason: "missing" });
    expect(verifyComputeApprovalToken("nodot", exp)).toEqual({ ok: false, reason: "malformed" });
    const [payload, sig] = token.split(".");
    expect(verifyComputeApprovalToken(`${payload}.${sig.slice(0, -2)}xx`, exp)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const forged = Buffer.from(JSON.stringify({ v: 1, job: "j2" }), "utf8").toString("base64url");
    expect(verifyComputeApprovalToken(`${forged}.${sig}`, exp)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyComputeApprovalToken(token, { ...exp, now: NOW + 5 * 60_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyComputeApprovalToken(token, { ...exp, jobId: "j2" })).toEqual({
      ok: false,
      reason: "job_mismatch",
    });
    expect(verifyComputeApprovalToken(token, { ...exp, quoteHash: "deadbeef" })).toEqual({
      ok: false,
      reason: "quote_mismatch",
    });
    // None of the refusals consumed it.
    expect(verifyComputeApprovalToken(token, exp).ok).toBe(true);
  });

  it("does not accept a token minted by another process (different secret)", () => {
    const { token } = minted();
    resetComputePaymentForTest();
    const q = quote();
    expect(
      verifyComputeApprovalToken(token, { jobId: q.jobId, quoteHash: q.quoteHash, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("approveComputeFunding", () => {
  let dir: string;
  let reviewStore: ReviewStore;
  let service: ReviewService;
  let deliveries: ComputeDeliveryStore;

  beforeEach(async () => {
    resetComputePaymentForTest();
    resetSpendGateForTest();
    resetGatedWalletForTest();
    vi.mocked(recordConsideration).mockClear();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-compute-pay-"));
    reviewStore = ReviewStore.open(path.join(dir, "review.sqlite"));
    service = new ReviewService({ store: reviewStore, executors: new Map() });
    resetReviewServiceForTest(service);
    deliveries = ComputeDeliveryStore.inMemory();
  });

  afterEach(async () => {
    resetReviewServiceForTest(null);
    deliveries.close();
    reviewStore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function backend(over: Partial<ComputeBackend> = {}) {
    const quoteFn = vi.fn(async () => quote());
    // The signer's duty, as the docs state it: verify (and so consume) the
    // token before building a transaction.
    const fund = vi.fn(async (req: { jobId: string; quoteHash: string; approvalToken: string }) => {
      const check = verifyComputeApprovalToken(req.approvalToken, {
        jobId: req.jobId,
        quoteHash: req.quoteHash,
        now: NOW,
      });
      if (!check.ok) {
        throw new Error(`signer refused token: ${check.reason}`);
      }
      return { txHash: "0xtx1", status: "pending" };
    });
    const b: ComputeBackend = {
      snapshot: async () => ({
        version: 1,
        asOf: 0,
        reachable: true,
        pools: [],
        workers: [],
        jobs: [],
      }),
      jobs: async () => [],
      job: async () => null,
      result: async () => null,
      quote: quoteFn,
      fund,
      ...over,
    };
    return { b, quoteFn, fund };
  }

  it("funds an owner approval through the spend gate with a single-use token, and records it", async () => {
    const { b, fund } = backend();
    const ledger = deliveries.ledger();
    const r = await approveComputeFunding({
      jobId: "j1",
      authority: { ...owner, reviewId: "rv-1" },
      backend: b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(r).toMatchObject({
      ok: true,
      jobId: "j1",
      amountUsdc: 0.5,
      payee: "0xOperator",
      txHash: "0xtx1",
    });
    expect(fund).toHaveBeenCalledTimes(1);
    const req = fund.mock.calls[0]![0] as {
      jobId: string;
      quoteHash: string;
      amountUsdc: number;
      approvalToken: string;
      idempotencyKey: string;
    };
    expect(req).toMatchObject({ jobId: "j1", amountUsdc: 0.5, quoteHash: quote().quoteHash });
    expect(req.idempotencyKey).toMatch(/^compute-fund:j1:/);
    // The signer consumed the token inside fund(); nobody can use it again.
    expect(
      verifyComputeApprovalToken(req.approvalToken, {
        jobId: "j1",
        quoteHash: req.quoteHash,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "consumed" });
    // Ledger: a pending row settled by a funded row; the job cannot be funded twice.
    expect(ledger.paymentSummary(0)).toMatchObject({
      attempts: 1,
      funded: 1,
      fundedUsdc: 0.5,
      refused: 0,
      pending: 0,
    });
    expect(ledger.recentPayments().map((r) => r.outcome)).toEqual(["funded", "pending"]);
    expect(ledger.fundedTxFor("j1")).toBe("0xtx1");
    expect(ledger.recentPayments()[0]).toMatchObject({
      reviewId: "rv-1",
      decidedBy: "victor",
      via: "control-ui",
    });
    // The token carried the deciding connection's scopes.
    const claims = JSON.parse(
      Buffer.from(req.approvalToken.split(".")[0]!, "base64url").toString("utf8"),
    ) as { scp: string[] };
    expect(claims.scp).toEqual(["operator.admin"]);
    // Spend gate: recorded as the owner's rpc spend.
    const decisions = service.listSpendDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      origin: "rpc",
      rail: "usdc",
      payee: "0xOperator",
      amountUsd: 0.5,
      verdict: "allow",
      outcome: "sent",
      txHash: "0xtx1",
    });
    expect(vi.mocked(recordConsideration)).toHaveBeenCalledWith(
      expect.objectContaining({ category: "compute-payment", decision: "acted" }),
    );
    const again = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: b,
      ledger,
      config: cfg,
      now: NOW + 1,
    });
    expect(again).toMatchObject({ ok: false, reason: "already_funded" });
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("refuses an agent-origin request before reading the quote, and the ledger shows it", async () => {
    const { b, quoteFn, fund } = backend();
    const ledger = deliveries.ledger();
    const r = await approveComputeFunding({
      jobId: "j1",
      authority: {
        origin: "agent",
        scopes: ["operator.admin"],
        via: "control-ui",
        decidedBy: "agent",
      },
      backend: b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "agent_origin" });
    expect(quoteFn).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();
    expect(ledger.paymentSummary(0)).toMatchObject({ refused: 1, agentOriginRefusals: 1 });
    expect(service.listSpendDecisions()).toHaveLength(0);
    expect(vi.mocked(recordConsideration)).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "compute-payment",
        decision: "blocked",
        reason: "agent_origin",
      }),
    );
  });

  it.each([
    ["chat_decision", { ...owner, via: "chat" }],
    ["internal_connection", { ...owner, connectionMode: "backend" }],
    ["missing_scope", { ...owner, scopes: ["operator.approvals-not"] }],
  ])("refuses %s at the signer even though a quote exists", async (reason, authority) => {
    const { b, fund } = backend();
    const ledger = deliveries.ledger();
    const r = await approveComputeFunding({
      jobId: "j1",
      authority,
      backend: b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason, amountUsdc: 0.5 });
    expect(fund).not.toHaveBeenCalled();
    expect(ledger.paymentSummary(0).refusalsByReason[reason]).toBe(1);
  });

  it("accepts the approvals scope from the review surface", async () => {
    const { b, fund } = backend();
    const r = await approveComputeFunding({
      jobId: "j1",
      authority: {
        origin: "owner",
        scopes: ["operator.approvals"],
        via: "control-ui",
        decidedBy: "o",
      },
      backend: b,
      ledger: deliveries.ledger(),
      config: cfg,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("refuses when the paid path is off, the quote changed, there is no quote, or the backend cannot fund", async () => {
    const ledger = deliveries.ledger();
    const off = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: backend().b,
      ledger,
      config: {} as BitterbotConfig,
      now: NOW,
    });
    expect(off).toMatchObject({ ok: false, reason: "paid_disabled" });
    const changed = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      expectedQuoteHash: "other",
      backend: backend().b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(changed).toMatchObject({ ok: false, reason: "quote_changed" });
    const none = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: backend({ quote: async () => null }).b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(none).toMatchObject({ ok: false, reason: "no_quote" });
    const { b } = backend();
    delete b.fund;
    const unsupported = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(unsupported).toMatchObject({ ok: false, reason: "unsupported" });
    const expired = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: backend({ quote: async () => quote({ expiresAt: NOW - 1 }) }).b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(expired).toMatchObject({ ok: false, reason: "quote_expired" });
    expect(ledger.paymentSummary(0)).toMatchObject({ refused: 5, funded: 0 });
    expect(service.listSpendDecisions()).toHaveLength(0);
  });

  it("applies the per-job and rolling daily caps from the ledger", async () => {
    const ledger = deliveries.ledger();
    const big = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: backend({ quote: async () => quote({ amountUsdc: 2.5 }) }).b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(big).toMatchObject({ ok: false, reason: "over_cap" });
    // Two funded jobs today: 1.5 + 1.0 = 2.5 of a 3 USDC day; a 0.6 job tips it over.
    for (const [id, amount] of [
      ["a", 1.5],
      ["b", 1.0],
    ] as const) {
      const r = await approveComputeFunding({
        jobId: id,
        authority: owner,
        backend: backend({ quote: async () => quote({ jobId: id, amountUsdc: amount }) }).b,
        ledger,
        config: cfg,
        now: NOW,
      });
      expect(r.ok).toBe(true);
    }
    const over = await approveComputeFunding({
      jobId: "c",
      authority: owner,
      backend: backend({ quote: async () => quote({ jobId: "c", amountUsdc: 0.6 }) }).b,
      ledger,
      config: cfg,
      now: NOW + 1000,
    });
    expect(over).toMatchObject({ ok: false, reason: "over_daily_cap" });
    // A day later the window has moved on.
    const later = await approveComputeFunding({
      jobId: "c",
      authority: owner,
      backend: backend({ quote: async () => quote({ jobId: "c", amountUsdc: 0.6 }) }).b,
      ledger,
      config: cfg,
      now: NOW + 25 * 60 * 60_000,
    });
    expect(later.ok).toBe(true);
  });

  it("refuses to fund without a ledger instead of running without caps", async () => {
    const { b, quoteFn, fund } = backend();
    const r = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: b,
      ledger: null,
      config: cfg,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "ledger_unavailable" });
    expect(quoteFn).not.toHaveBeenCalled();
    expect(fund).not.toHaveBeenCalled();
  });

  it("funds a job once under concurrent approvals, and blocks on a stale pending row", async () => {
    const ledger = deliveries.ledger();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFund = vi.fn(async () => {
      await gate;
      return { txHash: "0xslow", status: "pending" };
    });
    const slow = backend({ fund: slowFund });
    const args = { jobId: "j1", authority: owner, backend: slow.b, ledger, config: cfg, now: NOW };
    const first = approveComputeFunding(args);
    const second = approveComputeFunding(args);
    expect(await second).toMatchObject({ ok: false, reason: "in_progress" });
    release();
    expect(await first).toMatchObject({ ok: true, txHash: "0xslow" });
    expect(slowFund).toHaveBeenCalledTimes(1);
    expect(ledger.paymentSummary(0)).toMatchObject({
      funded: 1,
      refusalsByReason: { in_progress: 1 },
    });

    // A pending row left behind by a crash blocks for the window, then clears.
    ledger.recordPayment({
      ts: NOW,
      jobId: "j9",
      quoteHash: null,
      amountUsdc: 0.5,
      payee: null,
      outcome: "pending",
      reason: null,
      reviewId: null,
      decidedBy: "v",
      via: "cli",
      txHash: null,
    });
    const j9 = () => backend({ quote: async () => quote({ jobId: "j9" }) }).b;
    const blocked = await approveComputeFunding({
      jobId: "j9",
      authority: owner,
      backend: j9(),
      ledger,
      config: cfg,
      now: NOW + 60_000,
    });
    expect(blocked).toMatchObject({ ok: false, reason: "in_progress" });
    const later = await approveComputeFunding({
      jobId: "j9",
      authority: owner,
      backend: j9(),
      ledger,
      config: cfg,
      now: NOW + 11 * 60_000,
    });
    expect(later.ok).toBe(true);
  });

  it("records a failed funding and leaves the job approvable again", async () => {
    const ledger = deliveries.ledger();
    const { b } = backend({
      fund: vi.fn(async () => {
        throw new Error("escrow reverted");
      }),
    });
    const r = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: b,
      ledger,
      config: cfg,
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "fund_failed" });
    expect(r.ok ? "" : r.message).toMatch(/escrow reverted/);
    expect(ledger.paymentSummary(0)).toMatchObject({ failed: 1, funded: 0, pending: 0 });
    expect(ledger.fundedTxFor("j1")).toBeNull();
    expect(service.listSpendDecisions()[0]).toMatchObject({ verdict: "allow", outcome: "failed" });
    const retry = await approveComputeFunding({
      jobId: "j1",
      authority: owner,
      backend: backend().b,
      ledger,
      config: cfg,
      now: NOW + 1,
    });
    expect(retry.ok).toBe(true);
  });
});
