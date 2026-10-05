import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A provider whose send takes time, as an on-chain transaction does. The
// daily-limit guard has to hold while sends are in flight, not only once
// they are recorded.
const sendTransaction = vi.fn<() => Promise<string>>();
vi.mock("@coinbase/agentkit", () => ({
  CdpEvmWalletProvider: {
    configureWithWallet: async () => ({
      sendTransaction,
      getAddress: () => "0x" + "2".repeat(40),
    }),
  },
  X402ActionProvider: class {},
}));
vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: class {
    evm = { getOrCreateAccount: async () => ({ address: "0x" + "2".repeat(40) }) };
  },
}));

import { createWalletService } from "./wallet-service.js";

const CDP_ENV_KEYS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;
const RECIPIENT = "0x" + "1".repeat(40);

let storePath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  storePath = await mkdtemp(path.join(tmpdir(), "wallet-concurrent-"));
  for (const key of CDP_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    process.env[key] = "test";
  }
  sendTransaction.mockReset();
  sendTransaction.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve("0x" + "a".repeat(64)), 20)),
  );
});

afterEach(() => {
  for (const key of CDP_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function service(dailySpendLimitUsd: number) {
  return createWalletService({
    network: "base-sepolia",
    walletStorePath: storePath,
    dailySpendLimitUsd,
  });
}

describe("daily spend limit under concurrent sends", () => {
  it("sends at most the daily limit and records every send", async () => {
    const wallet = service(5);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => wallet.sendUsdc(RECIPIENT, 1)),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(sendTransaction).toHaveBeenCalledTimes(5);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(String(r.reason)).toMatch(/Daily spend limit would be exceeded/);
      }
    }
    const history = await wallet.getTransactionHistory(100);
    expect(history.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(5);
    await expect(wallet.sendUsdc(RECIPIENT, 1)).rejects.toThrow(
      /Daily spend limit would be exceeded/,
    );
  });

  it("frees the held amount when the send fails", async () => {
    sendTransaction.mockRejectedValueOnce(new Error("nonce too low"));
    const wallet = service(1);

    await expect(wallet.sendUsdc(RECIPIENT, 1)).rejects.toThrow(/Failed to send USDC/);
    await expect(wallet.sendUsdc(RECIPIENT, 1)).resolves.toMatchObject({ status: "pending" });
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  // The app builds a wallet service per agent run, per paid A2A task, per
  // payout tick and for the gateway RPC. They share one budget, so they have
  // to share the hold.
  it("holds the limit across separate wallet services on the same store", async () => {
    const wallets = [];
    for (let i = 0; i < 10; i += 1) {
      const wallet = service(5);
      await wallet.getAddress();
      wallets.push(wallet);
    }

    const results = await Promise.allSettled(wallets.map((w) => w.sendUsdc(RECIPIENT, 1)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(sendTransaction).toHaveBeenCalledTimes(5);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(String(r.reason)).toMatch(/Daily spend limit would be exceeded/);
      }
    }
    const history = await service(5).getTransactionHistory(100);
    expect(history.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(5);
  });

  // Once sendTransaction returns, the money has moved. Reporting a failure
  // then is how a spend gets made twice: an agent retries, and the payout
  // queue re-sends the same payment on its next tick.
  it("reports a send that went through as sent even when it cannot be written down", async () => {
    const wallet = service(5);
    await wallet.getAddress();
    const historyPath = path.join(storePath, "tx-history.json");
    // A directory where the history file should be: every read and write fails.
    await mkdir(historyPath);

    await expect(wallet.sendUsdc(RECIPIENT, 3)).resolves.toMatchObject({ status: "pending" });
    expect(sendTransaction).toHaveBeenCalledTimes(1);

    // It still counts against the limit, from any wallet service on the store.
    await expect(service(5).sendUsdc(RECIPIENT, 3)).rejects.toThrow(
      /Daily spend limit would be exceeded: \$3\.00 spent/,
    );
    expect(sendTransaction).toHaveBeenCalledTimes(1);

    // And it is written with the next spend that can be.
    await rm(historyPath, { recursive: true });
    await wallet.sendUsdc(RECIPIENT, 1);
    const history = await wallet.getTransactionHistory(100);
    expect(history.map((r) => Number(r.amount)).toSorted()).toEqual([1, 3]);
  });
});
