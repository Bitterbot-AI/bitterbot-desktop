import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the heavy CDP modules: initProvider() dynamic-imports them before its
// credential check, and the real @coinbase/agentkit import takes tens of
// seconds cold. The guards under test all run before any provider call, so
// the stubs only need to exist, not behave.
vi.mock("@coinbase/agentkit", () => ({
  CdpEvmWalletProvider: { configureWithWallet: async () => ({}) },
  X402ActionProvider: class {},
}));
vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: class {
    evm = { getOrCreateAccount: async () => ({ address: "0x" + "2".repeat(40) }) };
  },
}));

import { createWalletService } from "./wallet-service.js";

// These tests exercise the spend-guard choke points (per-tx cap + rolling 24h
// daily limit) that PLAN-29 Phase 0 requires before bounty payouts can
// auto-dispatch. Both guards run BEFORE the CDP provider is initialized, so no
// credentials are needed: a rejection proves the guard fired first, and a
// "Missing required CDP credentials" error proves the guard let the call
// through to provider init.

const CDP_ENV_KEYS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;

let storePath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  storePath = await mkdtemp(path.join(tmpdir(), "wallet-limits-"));
  for (const key of CDP_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CDP_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function service(overrides: { perTransactionCapUsd?: number; dailySpendLimitUsd?: number } = {}) {
  return createWalletService({
    network: "base-sepolia",
    walletStorePath: storePath,
    ...overrides,
  });
}

async function seedHistory(rows: { type: string; amount: string; ageMs: number }[]) {
  const records = rows.map((r, i) => ({
    txHash: `0xseed${i}`,
    type: r.type,
    amount: r.amount,
    token: "USDC",
    timestamp: Date.now() - r.ageMs,
  }));
  await writeFile(path.join(storePath, "tx-history.json"), JSON.stringify(records), "utf-8");
}

describe("per-transaction cap", () => {
  it("rejects sends above the default $25 cap before touching the provider", async () => {
    await expect(service().sendUsdc("0x" + "1".repeat(40), 26)).rejects.toThrow(
      /exceeds per-transaction cap of \$25/,
    );
  });

  it("rejects non-positive amounts", async () => {
    await expect(service().sendUsdc("0x" + "1".repeat(40), 0)).rejects.toThrow(/must be positive/);
    await expect(service().sendUsdc("0x" + "1".repeat(40), -3)).rejects.toThrow(/must be positive/);
  });

  it("honors a configured cap", async () => {
    await expect(
      service({ perTransactionCapUsd: 5 }).sendUsdc("0x" + "1".repeat(40), 6),
    ).rejects.toThrow(/exceeds per-transaction cap of \$5/);
  });

  it("applies the same cap to payForResource", async () => {
    await expect(service().payForResource("https://peer.example/skill", 26)).rejects.toThrow(
      /exceeds per-transaction cap of \$25/,
    );
  });
});

describe("rolling 24h daily limit", () => {
  it("rejects a send that would exceed the daily limit across send + x402 rows", async () => {
    await seedHistory([
      { type: "send", amount: "30", ageMs: 60_000 },
      { type: "x402_payment", amount: "19", ageMs: 120_000 },
    ]);
    await expect(service().sendUsdc("0x" + "1".repeat(40), 2)).rejects.toThrow(
      /Daily spend limit would be exceeded/,
    );
  });

  it("ignores spend older than 24h", async () => {
    await seedHistory([
      { type: "send", amount: "49", ageMs: 25 * 60 * 60 * 1000 },
      { type: "send", amount: "1", ageMs: 60_000 },
    ]);
    // Guard passes ($1 in window + $2 < $50), so the call proceeds to provider
    // init and fails on missing credentials — proving the limit did NOT fire.
    await expect(service().sendUsdc("0x" + "1".repeat(40), 2)).rejects.toThrow(
      /Missing required CDP credentials/,
    );
  });

  it("ignores non-spend record types", async () => {
    await seedHistory([{ type: "receive", amount: "500", ageMs: 60_000 }]);
    await expect(service().sendUsdc("0x" + "1".repeat(40), 2)).rejects.toThrow(
      /Missing required CDP credentials/,
    );
  });

  it("honors a configured daily limit", async () => {
    await seedHistory([{ type: "send", amount: "9", ageMs: 60_000 }]);
    await expect(
      service({ dailySpendLimitUsd: 10 }).sendUsdc("0x" + "1".repeat(40), 2),
    ).rejects.toThrow(/Daily spend limit would be exceeded/);
  });

  it("allows spending exactly up to the limit", async () => {
    await seedHistory([{ type: "send", amount: "45", ageMs: 60_000 }]);
    // $45 + $5 == $50 cap: not exceeded, proceeds to credential failure.
    await expect(service().sendUsdc("0x" + "1".repeat(40), 5)).rejects.toThrow(
      /Missing required CDP credentials/,
    );
  });
});
