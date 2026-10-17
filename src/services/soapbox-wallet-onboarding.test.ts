import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SoapboxPaymentQuote } from "../infra/soapbox-client.js";

let directory: string | undefined;
afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("@coinbase/cdp-sdk");
  vi.doUnmock("./wallet-service.js");
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("stores GUI credentials only in the Compute test wallet and passes them explicitly to signing", async () => {
  directory = await mkdtemp(path.join(tmpdir(), "soapbox-wallet-onboarding-"));
  vi.doMock("node:os", () => ({ homedir: () => directory }));
  const address = `0x${"1".repeat(40)}`;
  const account = vi.fn(async () => ({ address }));
  const construct = vi.fn();
  vi.doMock("@coinbase/cdp-sdk", () => ({
    CdpClient: class {
      evm = { getOrCreateAccount: account };
      constructor(auth: unknown) {
        construct(auth);
      }
    },
  }));
  const create = vi.fn(() => ({}));
  vi.doMock("./wallet-service.js", () => ({ createWalletService: create }));
  const { initializeSoapboxWallet, createSoapboxWallet, soapboxWalletDirectory } =
    await import("./soapbox-wallet.js");
  const auth = { apiKeyId: "test-id", apiKeySecret: "test-key", walletSecret: "test-secret" };
  const main = {
    enabled: true,
    network: "base" as const,
    walletStorePath: path.join(directory, "mainnet"),
  };
  const envSecret = process.env.CDP_WALLET_SECRET;
  expect(await initializeSoapboxWallet(main, auth)).toBe(address);
  expect(account).toHaveBeenCalledWith({ name: "bitterbot-compute-base-sepolia" });
  expect(
    JSON.parse(await readFile(path.join(soapboxWalletDirectory, "credentials.json"), "utf8")),
  ).toEqual(auth);
  await createSoapboxWallet(main);
  expect(create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      network: "base-sepolia",
      walletStorePath: soapboxWalletDirectory,
      cdpApiKeyId: "test-id",
      cdpApiKeySecret: "test-key",
    }),
    expect.objectContaining({
      walletSecret: "test-secret",
      accountName: "bitterbot-compute-base-sepolia",
      expectedAddress: address,
    }),
  );
  expect(process.env.CDP_WALLET_SECRET).toBe(envSecret);
  expect(main.network).toBe("base");
  account.mockResolvedValue({ address: `0x${"2".repeat(40)}` });
  await expect(initializeSoapboxWallet(main, { ...auth, apiKeyId: "wrong-id" })).rejects.toThrow(
    "different test wallet",
  );
  expect(
    JSON.parse(await readFile(path.join(soapboxWalletDirectory, "credentials.json"), "utf8")),
  ).toEqual(auth);
  const before = await readFile(path.join(soapboxWalletDirectory, "wallet-data.json"), "utf8");
  await mkdir(main.walletStorePath, { recursive: true });
  await writeFile(
    path.join(main.walletStorePath, "wallet-data.json"),
    JSON.stringify({ address, ownerAddress: address }),
  );
  await expect(createSoapboxWallet(main)).rejects.toThrow("addresses must be separate");
  expect(await readFile(path.join(soapboxWalletDirectory, "wallet-data.json"), "utf8")).toBe(
    before,
  );
  await writeFile(
    path.join(main.walletStorePath, "wallet-data.json"),
    JSON.stringify({ address: `0x${"3".repeat(40)}` }),
  );
  await writeFile(
    path.join(soapboxWalletDirectory, "wallet-data.json"),
    JSON.stringify({ name: "bitterbot-owner-base-sepolia", address }),
  );
  await expect(createSoapboxWallet({ ...main, network: "base-sepolia" })).rejects.toThrow(
    "Legacy Compute identity conflicts",
  );
  await createSoapboxWallet(main);
  expect(create).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      accountName: "bitterbot-owner-base-sepolia",
      expectedAddress: address,
    }),
  );
  const fund = vi.fn(async () => ({ status: "funded", txHash: "0xtest" }));
  create.mockReturnValue({ fundSoapbox: fund });
  const payment = {
    chain_id: 84532,
    token: `0x${"4".repeat(40)}`,
    escrow: `0x${"5".repeat(40)}`,
    key: `0x${"a".repeat(64)}`,
    buyer: address,
    operator: `0x${"6".repeat(40)}`,
    amount_microusdc: 2000,
    expires: 2000000000,
  } as SoapboxPaymentQuote;
  await expect((await createSoapboxWallet(main)).fundSoapbox(payment)).rejects.toThrow("approve");
  const approvedWallet = await createSoapboxWallet(main, payment);
  payment.amount_microusdc = 3000;
  await expect(approvedWallet.fundSoapbox(payment)).rejects.toThrow("changed");
  expect(fund).not.toHaveBeenCalled();
  await approvedWallet.fundSoapbox({ ...payment, amount_microusdc: 2000 });
  expect(fund).toHaveBeenCalledTimes(1);
  const decision = JSON.parse(
    (await readFile(path.join(soapboxWalletDirectory, "funding-approvals.jsonl"), "utf8")).trim(),
  );
  expect(decision).toMatchObject({
    decision: "user_reviewed",
    amount_microusdc: 2000,
    key: payment.key,
  });
  expect(JSON.stringify(decision)).not.toMatch(/test-secret|test-key/);
});
