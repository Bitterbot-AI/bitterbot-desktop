import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoapboxPaymentQuote } from "../infra/soapbox-client.js";
import { createWalletService } from "./wallet-service.js";

const fake = vi.hoisted(() => ({ send: vi.fn(), address: `0x${"2".repeat(40)}` }));
vi.mock("@coinbase/agentkit", () => ({
  CdpEvmWalletProvider: {
    configureWithWallet: async () => ({
      getAddress: () => fake.address,
      sendTransaction: fake.send,
    }),
  },
}));
vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: class {
    evm = { getOrCreateAccount: async () => ({ address: fake.address }) };
  },
}));
vi.mock("./soapbox-payment.js", () => ({
  validateSoapboxQuote: vi.fn(),
  fundSoapboxEscrow: async ({ reserve }: { reserve: () => Promise<void> }) => {
    await reserve();
    fake.send();
    return { status: "funded", txHash: "test" };
  },
}));
let store: string;
beforeEach(async () => {
  store = await mkdtemp(path.join(tmpdir(), "soapbox-budget-"));
  vi.stubEnv("CDP_API_KEY_ID", "test");
  vi.stubEnv("CDP_API_KEY_SECRET", "test");
  vi.stubEnv("CDP_WALLET_SECRET", "test");
  fake.send.mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(store, { recursive: true, force: true });
});
const quote = {
  chain_id: 84532,
  escrow: `0x${"3".repeat(40)}`,
  key: `0x${"4".repeat(64)}`,
  amount_microusdc: 33000,
} as SoapboxPaymentQuote;
const service = (walletStorePath: string) =>
  createWalletService({
    network: "base-sepolia",
    walletStorePath,
    dailySpendLimitUsd: 1,
    perTransactionCapUsd: 0.1,
  });
describe("Soapbox wallet spend reservations", () => {
  it("rejects mainnet and an over-cap quote before broadcasting", async () => {
    await expect(
      createWalletService({ network: "base", walletStorePath: store }).fundSoapbox!(quote),
    ).rejects.toThrow("Base Sepolia");
    await expect(
      service(store).fundSoapbox!({ ...quote, amount_microusdc: 200000 }),
    ).rejects.toThrow("per-transaction cap");
    expect(fake.send).not.toHaveBeenCalled();
  });
  it("persists one reservation across fresh wallet instances and retries", async () => {
    await service(store).fundSoapbox!(quote);
    await service(store).fundSoapbox!(quote);
    const history = JSON.parse(await readFile(path.join(store, "tx-history.json"), "utf8"));
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe("0.033");
  });
  it("retains more than 500 current spends and applies the shared daily cap", async () => {
    const file = path.join(store, "tx-history.json");
    await writeFile(
      file,
      JSON.stringify(
        Array.from({ length: 600 }, (_, i) => ({
          txHash: `old-${i}`,
          type: "send",
          token: "USDC",
          amount: "0.001",
          timestamp: Date.now(),
        })),
      ),
    );
    await service(store).fundSoapbox!(quote);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(601);
    const capped = createWalletService({
      network: "base-sepolia",
      walletStorePath: store,
      dailySpendLimitUsd: 0.64,
    });
    await expect(capped.fundSoapbox!({ ...quote, key: `0x${"5".repeat(64)}` })).rejects.toThrow(
      "Daily spend limit",
    );
    expect(fake.send).toHaveBeenCalledTimes(1);
  });
});
