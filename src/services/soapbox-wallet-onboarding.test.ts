import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

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
  expect(account).toHaveBeenCalledWith({ name: "bitterbot-owner-base-sepolia" });
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
    expect.objectContaining({ walletSecret: "test-secret" }),
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
});
