import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import type { WalletConfig } from "../config/types.wallet.js";
import type { SoapboxWalletStatus } from "../infra/soapbox-client.js";
import { createWalletService } from "./wallet-service.js";

export const soapboxWalletDirectory = path.join(
  homedir(),
  ".bitterbot-soapbox",
  "wallet",
  "base-sepolia",
);

/** Only CDP authentication is shared. Network, account, ledger and caps are independent. */
export function soapboxWalletConfig(mainWallet?: WalletConfig): WalletConfig {
  return {
    enabled: true,
    network: "base-sepolia",
    walletStorePath: soapboxWalletDirectory,
    perTransactionCapUsd: 0.1,
    dailySpendLimitUsd: 1,
    cdpApiKeyId: mainWallet?.cdpApiKeyId,
    cdpApiKeySecret: mainWallet?.cdpApiKeySecret,
  };
}

export async function createSoapboxWallet(mainWallet?: WalletConfig) {
  await mkdir(soapboxWalletDirectory, { recursive: true, mode: 0o700 });
  const mainDirectory = mainWallet?.walletStorePath ?? path.join(homedir(), ".bitterbot", "wallet");
  const mainResolved = await realpath(mainDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return path.resolve(mainDirectory);
  });
  if ((await realpath(soapboxWalletDirectory)) === mainResolved)
    throw new Error("Compute and main wallet stores must be separate");
  return createWalletService(soapboxWalletConfig(mainWallet));
}

export async function getSoapboxWalletStatus(): Promise<SoapboxWalletStatus> {
  const status: SoapboxWalletStatus = {
    network: "base-sepolia",
    chain_id: 84532,
    address: null,
    balance_usdc: null,
    per_transaction_usdc: 0.1,
    daily_limit_usdc: 1,
  };
  try {
    const stored = JSON.parse(
      await readFile(path.join(soapboxWalletDirectory, "wallet-data.json"), "utf8"),
    );
    if (stored.name !== "bitterbot-owner-base-sepolia" || !/^0x[\da-f]{40}$/i.test(stored.address))
      throw new Error("Invalid Compute test wallet identity");
    status.address = stored.address;
    const rpc = process.env.BITTERBOT_SOAPBOX_RPC_URL ?? "https://sepolia.base.org";
    if (new URL(rpc).protocol !== "https:") throw new Error("Payment RPC requires HTTPS");
    // Never use RPC_URL or NETWORK_ID: they belong to the main wallet.
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(rpc, { timeout: 8000, retryCount: 1 }),
    });
    if ((await client.getChainId()) !== 84532) throw new Error("Wrong Compute wallet chain");
    status.balance_usdc = formatUnits(
      await client.readContract({
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [stored.address],
      }),
      6,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      status.error = "Test wallet balance unavailable; retry shortly.";
  }
  return status;
}
