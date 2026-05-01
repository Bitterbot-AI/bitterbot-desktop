import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// Mock viem before importing the module under test so we don't actually hit Base.
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: async ({ hash }: { hash: string }) => mockedReceipt(hash),
    }),
    recoverMessageAddress: async ({
      message: _msg,
      signature,
    }: {
      message: string;
      signature: string;
    }) => {
      // Test fixture: signatures of the form "valid:<addr>" recover to <addr>;
      // anything else is an invalid signature.
      const m = /^valid:(0x[a-fA-F0-9]{40})$/.exec(signature);
      if (m) return m[1];
      throw new Error("invalid signature");
    },
  };
});

vi.mock("viem/chains", () => ({
  base: { id: 8453 },
  baseSepolia: { id: 84532 },
}));

let mockedReceiptStore: Record<
  string,
  {
    status: "success" | "reverted";
    to: string;
    logs: { topics: string[]; data: string }[];
  }
> = {};
function mockedReceipt(hash: string) {
  const r = mockedReceiptStore[hash.toLowerCase()];
  if (!r) throw new Error(`no mock receipt for ${hash}`);
  return r;
}

import { verifyX402Payment } from "./x402-verify.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function topicForAddress(addr: string): string {
  // ERC-20 Transfer indexed addresses are 32-byte left-padded
  return "0x" + "0".repeat(24) + addr.replace(/^0x/, "").toLowerCase();
}

function encodeToken(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("verifyX402Payment", () => {
  const recipient = "0x" + "11".repeat(20);
  const sender = "0x" + "22".repeat(20);
  const usdcContract = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  function setReceipt(
    hash: string,
    opts?: {
      status?: "success" | "reverted";
      to?: string;
      transferTo?: string;
    },
  ) {
    mockedReceiptStore[hash.toLowerCase()] = {
      status: opts?.status ?? "success",
      to: opts?.to ?? usdcContract,
      logs: [
        {
          topics: [
            TRANSFER_TOPIC,
            topicForAddress(sender),
            topicForAddress(opts?.transferTo ?? recipient),
          ],
          data: "0x0",
        },
      ],
    };
  }

  it("rejects token with missing txHash", async () => {
    const r = await verifyX402Payment({
      paymentToken: encodeToken({ amount: 0.05 }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Missing txHash/);
  });

  it("rejects token with amount below minimum", async () => {
    setReceipt("0xabc1");
    const r = await verifyX402Payment({
      paymentToken: encodeToken({ txHash: "0xabc1", amount: 0.001 }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/below minimum/);
  });

  it("rejects token with timestamp older than 5 minutes", async () => {
    const old = Date.now() - 6 * 60 * 1000;
    const r = await verifyX402Payment({
      paymentToken: encodeToken({ txHash: "0xabc2", amount: 0.05, timestamp: old }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/expired/);
  });

  it("rejects on-chain mismatch where Transfer.to is a DIFFERENT address (regression for substring bug)", async () => {
    const otherRecipient = "0x" + "33".repeat(20);
    setReceipt("0xabc3", { transferTo: otherRecipient });
    const r = await verifyX402Payment({
      paymentToken: encodeToken({
        txHash: "0xabc3",
        amount: 0.05,
        timestamp: Date.now(),
      }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/recipient does not match/);
  });

  it("accepts valid unsigned legacy token (with deprecation warning)", async () => {
    setReceipt("0xabc4");
    const r = await verifyX402Payment({
      paymentToken: encodeToken({
        txHash: "0xabc4",
        amount: 0.05,
        sender,
        timestamp: Date.now(),
      }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(true);
    expect(r.signatureVerified).toBe(false);
  });

  it("verifies a signed v1 token whose signature recovers to declared sender", async () => {
    setReceipt("0xabc5");
    const r = await verifyX402Payment({
      paymentToken: encodeToken({
        version: "v1",
        txHash: "0xabc5",
        amount: 0.05,
        sender,
        recipient,
        timestamp: Date.now(),
        signature: `valid:${sender}`,
      }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(true);
    expect(r.signatureVerified).toBe(true);
  });

  it("rejects a signed v1 token whose signature recovers to a different address", async () => {
    setReceipt("0xabc6");
    const r = await verifyX402Payment({
      paymentToken: encodeToken({
        version: "v1",
        txHash: "0xabc6",
        amount: 0.05,
        sender,
        recipient,
        timestamp: Date.now(),
        signature: `valid:0x${"99".repeat(20)}`,
      }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/signature does not match declared sender/);
  });

  it("rejects a signed v1 token whose declared recipient does not match expected", async () => {
    const otherRecipient = "0x" + "44".repeat(20);
    setReceipt("0xabc7");
    const r = await verifyX402Payment({
      paymentToken: encodeToken({
        version: "v1",
        txHash: "0xabc7",
        amount: 0.05,
        sender,
        recipient: otherRecipient,
        timestamp: Date.now(),
        signature: `valid:${sender}`,
      }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/recipient does not match expected/);
  });

  it("rejects a token whose tx_hash has already been consumed (replay)", async () => {
    setReceipt("0xreplay");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE marketplace_purchases (
        tx_hash TEXT PRIMARY KEY,
        amount_usdc REAL,
        purchased_at INTEGER
      )
    `);
    db.prepare(
      "INSERT INTO marketplace_purchases (tx_hash, amount_usdc, purchased_at) VALUES (?, ?, ?)",
    ).run("0xreplay", 0.05, Date.now());
    const r = await verifyX402Payment({
      paymentToken: encodeToken({
        txHash: "0xreplay",
        amount: 0.05,
        sender,
        timestamp: Date.now(),
      }),
      expectedRecipient: recipient,
      minimumAmount: 0.01,
      network: "base",
      db,
    });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/already consumed/);
  });
});
