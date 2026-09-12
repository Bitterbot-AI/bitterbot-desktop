/**
 * PLAN-48 Phase 1: the A2A client's spend-grant gate on the outbound payment
 * path. With grantsRequired on, an uncovered spend raises an approval and does
 * NOT pay; with a covering grant (or grantsRequired off) the spend proceeds.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletService } from "./wallet-service.js";
import { loadNodeCircleSigner, verifyEd25519 } from "../payments/ap2/ed25519.js";
import { SpendGrantStore } from "../payments/grants/spend-grant-store.js";
import { buildSpendGrant, usdc } from "../payments/grants/spend-grant.js";
import { A2aClient, classifyOutcome } from "./a2a-client.js";

// Spy on escalation delivery so we can assert a raised approval is pushed to
// the operator (the notifier itself is unit-tested in escalation-notifier.test).
const { notifyEscalation } = vi.hoisted(() => ({ notifyEscalation: vi.fn(async () => {}) }));
vi.mock("../payments/grants/escalation-notifier.js", () => ({ notifyEscalation }));

const PEER = "https://peer.example";
const PAYTO = "0x00000000000000000000000000000000000000aa";

function mock402(price: number): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 402,
    json: async () => ({ error: { data: { payTo: PAYTO, pricing: { priceUsdc: price } } } }),
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

function walletStub(sendUsdc: ReturnType<typeof vi.fn>): WalletService {
  return {
    sendUsdc,
    getAddress: async () => "0x1593000000000000000000000000000000000000",
    signMessage: async (m: string) => "0x" + createHash("sha256").update(m).digest("hex"),
  } as unknown as WalletService;
}

describe("A2aClient spend-grant gate (PLAN-48 Phase 1)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    notifyEscalation.mockClear();
    vi.restoreAllMocks();
  });

  it("refuses an uncovered spend and raises an approval when grantsRequired", async () => {
    const db = new DatabaseSync(":memory:");
    const client = new A2aClient({ grantsRequired: true, taskTimeoutMs: 1000 }, db);
    const restore = mock402(0.05);
    const sendUsdc = vi.fn(async () => ({ txHash: "0xdead" }));
    const r = await client.executeTask({
      agentUrl: PEER,
      message: "hi",
      walletService: walletStub(sendUsdc),
    });
    restore();

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/awaiting approval/);
    expect(sendUsdc).not.toHaveBeenCalled(); // no money moved
    // An approval request was raised for the human to act on.
    const pending = new SpendGrantStore(db).listApprovals("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payee).toBe(PAYTO);
    // The raised approval was delivered to the operator (escalation push).
    expect(notifyEscalation).toHaveBeenCalledOnce();
    expect(notifyEscalation.mock.calls[0]![0]!.approvalId).toBe(pending[0]!.approvalId);
    // Our own refusal must not be scored against the peer.
    expect(classifyOutcome(r)).toBeNull();
  });

  it("pays when an active grant covers the spend (grantsRequired)", async () => {
    const db = new DatabaseSync(":memory:");
    const signer = await loadNodeCircleSigner();
    const grant = buildSpendGrant({
      ownerPubkey: signer.pubkey,
      scope: { allowed_payees: [PAYTO] },
      allowance: usdc(1),
      periodSeconds: 86_400,
      ttlMs: 3_600_000,
      signOwner: signer.signEd25519,
    });
    new SpendGrantStore(db).setGrant(grant, verifyEd25519);

    const client = new A2aClient({ grantsRequired: true, taskTimeoutMs: 1000 }, db);
    const restore = mock402(0.05);
    const sendUsdc = vi.fn(async () => ({ txHash: "0xbeef" }));
    // The retry fetch (post-payment) still resolves via the same mock (returns 402
    // shape); we only assert that payment was attempted, i.e. the gate let it through.
    await client.executeTask({
      agentUrl: PEER,
      message: "hi",
      walletService: walletStub(sendUsdc),
    });
    restore();

    expect(sendUsdc).toHaveBeenCalledTimes(1);
    // A covered spend needs no escalation.
    expect(notifyEscalation).not.toHaveBeenCalled();
    // Usage was recorded against the grant.
    const consumed = new SpendGrantStore(db);
    const res = consumed.activeGrantFor({ payee: PAYTO, amountUsd: 0.96, verifyEd25519 });
    expect(res.grant).toBeNull(); // 0.05 spent + 0.96 > 1 allowance => now uncovered
  });

  it("does not gate when grantsRequired is off (default)", async () => {
    const db = new DatabaseSync(":memory:");
    const client = new A2aClient({ taskTimeoutMs: 1000 }, db); // grantsRequired defaults false
    const restore = mock402(0.05);
    const sendUsdc = vi.fn(async () => ({ txHash: "0xfeed" }));
    await client.executeTask({
      agentUrl: PEER,
      message: "hi",
      walletService: walletStub(sendUsdc),
    });
    restore();

    expect(sendUsdc).toHaveBeenCalledTimes(1); // spends despite no grant
    expect(new SpendGrantStore(db).listApprovals("pending")).toHaveLength(0);
  });
});
