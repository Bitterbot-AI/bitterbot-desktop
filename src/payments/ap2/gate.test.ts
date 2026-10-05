import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletService } from "../../services/wallet-service.js";
import {
  gateWallet,
  resetSpendGateForTest,
  sessionSpentUsd,
  type SpendDecision,
  SpendRefusedError,
} from "./gate.js";

/**
 * The gate is where every outbound payment is decided and written down,
 * whichever route asked for it.
 */

let decisions: SpendDecision[];
let approved: boolean;
let now: number;
let sendUsdc: ReturnType<typeof vi.fn>;
let payForResource: ReturnType<typeof vi.fn>;

const wallet = () =>
  ({
    sendUsdc,
    payForResource,
    getAddress: async () => "0xself",
  }) as unknown as WalletService;

const deps = () => ({
  record: (d: SpendDecision) => decisions.push(d),
  isApproved: () => approved,
  now: () => now,
});

beforeEach(() => {
  resetSpendGateForTest();
  decisions = [];
  approved = false;
  now = 1_000_000;
  sendUsdc = vi.fn(async () => ({ txHash: "0xabc", status: "pending" }));
  payForResource = vi.fn(async () => ({ success: true, amountPaid: 0.4, txHash: "0xdef" }));
});

describe("gateWallet", () => {
  it("lets a reviewed wallet-tool send through and writes down why", async () => {
    const gated = gateWallet(
      wallet(),
      { origin: "wallet-tool", sessionKey: "s1", sessionCapUsd: 50 },
      deps(),
    );

    await expect(gated.sendUsdc("0xbob", 5)).resolves.toMatchObject({ txHash: "0xabc" });

    expect(decisions).toMatchObject([
      {
        origin: "wallet-tool",
        rail: "usdc",
        payee: "0xbob",
        amountUsd: 5,
        verdict: "allow",
        reason: "passed review",
        outcome: "sent",
        txHash: "0xabc",
        sessionKey: "s1",
      },
    ]);
    // Everything that is not a payment passes straight through.
    await expect(gated.getAddress()).resolves.toBe("0xself");
  });

  it("keeps a session cap that outlives the run and the tool instance", async () => {
    const ctx = { origin: "wallet-tool" as const, sessionKey: "s1", sessionCapUsd: 10 };

    // Two separate wrapped wallets, as two runs of the same session would have.
    await gateWallet(wallet(), ctx, deps()).sendUsdc("0xbob", 6);
    await expect(gateWallet(wallet(), ctx, deps()).sendUsdc("0xbob", 6)).rejects.toThrow(
      /Session spend cap exceeded.*spent: \$6\.00/,
    );

    expect(sendUsdc).toHaveBeenCalledTimes(1);
    expect(decisions.at(-1)).toMatchObject({
      verdict: "deny",
      reason: "session cap",
      outcome: "refused",
    });
    // Another session has its own allowance, and the cap is over 24 hours.
    await gateWallet(wallet(), { ...ctx, sessionKey: "s2" }, deps()).sendUsdc("0xbob", 6);
    now += 24 * 60 * 60_000 + 1;
    expect(sessionSpentUsd("s1", now)).toBe(0);
    await gateWallet(wallet(), ctx, deps()).sendUsdc("0xbob", 6);
    expect(sendUsdc).toHaveBeenCalledTimes(3);
  });

  it("does not count a send that failed, and records the failure", async () => {
    sendUsdc.mockRejectedValueOnce(new Error("Failed to send USDC: nonce too low"));
    const gated = gateWallet(
      wallet(),
      { origin: "wallet-tool", sessionKey: "s1", sessionCapUsd: 10 },
      deps(),
    );

    await expect(gated.sendUsdc("0xbob", 6)).rejects.toThrow(/nonce too low/);

    expect(sessionSpentUsd("s1", now)).toBe(0);
    expect(decisions[0]).toMatchObject({
      verdict: "allow",
      outcome: "failed",
      error: expect.stringContaining("nonce"),
    });
  });

  describe("a paid task for another agent", () => {
    const ctx = {
      origin: "a2a" as const,
      approvalRequired: true,
      requestApproval: vi.fn(() => "APPROVAL-REQUIRED (rv-1): Pay 0.3 USDC ..."),
    };

    it("is refused and put to the owner when nothing authorises it", async () => {
      ctx.requestApproval.mockClear();
      const gated = gateWallet(wallet(), ctx, deps());

      await expect(gated.sendUsdc("0xseller", 0.3)).rejects.toThrow(SpendRefusedError);

      expect(ctx.requestApproval).toHaveBeenCalledWith({ payee: "0xseller", amountUsd: 0.3 });
      expect(sendUsdc).not.toHaveBeenCalled();
      expect(decisions[0]).toMatchObject({ verdict: "deny", reason: "needs approval" });
    });

    it("pays inside the owner's approval", async () => {
      approved = true;
      await gateWallet(wallet(), ctx, deps()).sendUsdc("0xseller", 0.3);

      expect(sendUsdc).toHaveBeenCalledTimes(1);
      expect(decisions[0]).toMatchObject({ verdict: "allow", reason: "approved by the owner" });
    });

    it("pays when a standing grant covers it", async () => {
      await gateWallet(wallet(), ctx, deps()).sendUsdc("0xseller", 0.3, {
        authorizedByGrant: "grant-7",
      } as never);

      expect(decisions[0]).toMatchObject({ verdict: "allow", reason: "standing grant grant-7" });
    });

    it("pays without asking when the owner turned spend review off", async () => {
      await gateWallet(wallet(), { ...ctx, approvalRequired: false }, deps()).sendUsdc(
        "0xseller",
        0.3,
      );
      expect(sendUsdc).toHaveBeenCalledTimes(1);
    });
  });

  it("lets a payout of money already owed through without approval, on the record", async () => {
    await gateWallet(wallet(), { origin: "payout", purpose: "royalty" }, deps()).sendUsdc(
      "0xauthor",
      1.25,
    );

    expect(decisions[0]).toMatchObject({
      origin: "payout",
      verdict: "allow",
      reason: "payout of an amount already owed",
      purpose: "royalty",
    });
  });

  it("records an x402 payment at what was actually charged", async () => {
    const gated = gateWallet(
      wallet(),
      { origin: "rpc", sessionKey: "s1", sessionCapUsd: 10 },
      deps(),
    );

    await expect(gated.payForResource("https://api.test/data", 1)).resolves.toMatchObject({
      success: true,
    });

    expect(decisions[0]).toMatchObject({
      rail: "x402",
      payee: "https://api.test/data",
      amountUsd: 0.4,
      outcome: "sent",
      txHash: "0xdef",
    });
    expect(sessionSpentUsd("s1", now)).toBe(0.4);
  });

  it("refuses an x402 payment over the session cap without calling the wallet", async () => {
    const gated = gateWallet(
      wallet(),
      { origin: "wallet-tool", sessionKey: "s1", sessionCapUsd: 0.5 },
      deps(),
    );

    const result = await gated.payForResource("https://api.test/data", 1);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Session spend cap exceeded");
    expect(payForResource).not.toHaveBeenCalled();
  });

  it("never lets a broken recorder block or fail a payment", async () => {
    const gated = gateWallet(
      wallet(),
      { origin: "payout" },
      {
        ...deps(),
        record: () => {
          throw new Error("disk full");
        },
      },
    );

    await expect(gated.sendUsdc("0xauthor", 1)).resolves.toMatchObject({ txHash: "0xabc" });
  });

  it("refuses an amount that is not a positive number", async () => {
    const gated = gateWallet(wallet(), { origin: "rpc" }, deps());
    await expect(gated.sendUsdc("0xbob", -1)).rejects.toThrow(/positive number/);
    await expect(gated.sendUsdc("0xbob", Number.NaN)).rejects.toThrow(/positive number/);
    expect(sendUsdc).not.toHaveBeenCalled();
  });
});
