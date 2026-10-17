import { describe, expect, it, vi } from "vitest";
import { soapboxWalletConfig, soapboxWalletDirectory } from "./soapbox-wallet.js";

vi.mock("./wallet-service.js", () => ({ createWalletService: vi.fn() }));

describe("dedicated Compute wallet", () => {
  it("copies only authentication from the main wallet, never its network, storage or limits", () => {
    const main = {
      enabled: true,
      network: "base" as const,
      walletStorePath: "/mainnet-wallet",
      perTransactionCapUsd: 500,
      dailySpendLimitUsd: 5000,
      cdpApiKeyId: "key-id",
      cdpApiKeySecret: "test-secret",
    };
    const before = structuredClone(main);
    expect(soapboxWalletConfig(main)).toEqual({
      enabled: true,
      network: "base-sepolia",
      walletStorePath: soapboxWalletDirectory,
      perTransactionCapUsd: 0.1,
      dailySpendLimitUsd: 1,
      cdpApiKeyId: "key-id",
      cdpApiKeySecret: "test-secret",
    });
    expect(main).toEqual(before);
    expect(soapboxWalletDirectory).not.toBe(main.walletStorePath);
  });
  it("uses testnet even when the main wallet is disabled", () => {
    expect(soapboxWalletConfig({ enabled: false, network: "base" }).network).toBe("base-sepolia");
  });
});
