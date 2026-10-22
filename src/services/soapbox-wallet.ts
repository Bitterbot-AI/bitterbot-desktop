import { appendFile, mkdir, readFile, realpath, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import type { WalletConfig } from "../config/types.wallet.js";
import type { SoapboxWalletStatus } from "../infra/soapbox-client.js";
import type { SoapboxPaymentQuote } from "../infra/soapbox-client.js";
import { gatedWallet } from "../review/spend.js";
import { assertApprovedSoapboxQuote } from "./soapbox-payment.js";
import { createWalletService } from "./wallet-service.js";

export const SOAPBOX_ACCOUNT_NAME = "bitterbot-compute-base-sepolia";
const LEGACY_ACCOUNT_NAME = "bitterbot-owner-base-sepolia";

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

export async function createSoapboxWallet(
  mainWallet?: WalletConfig,
  approvedQuote?: SoapboxPaymentQuote,
) {
  await mkdir(soapboxWalletDirectory, { recursive: true, mode: 0o700 });
  const mainDirectory = mainWallet?.walletStorePath ?? path.join(homedir(), ".bitterbot", "wallet");
  const mainResolved = await realpath(mainDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return path.resolve(mainDirectory);
  });
  if ((await realpath(soapboxWalletDirectory)) === mainResolved)
    throw new Error("Compute and main wallet stores must be separate");
  const identity = await readComputeIdentity();
  if (identity) await assertWalletSeparation(identity, mainWallet);
  const auth = await soapboxWalletAuthentication(mainWallet);
  const approved = approvedQuote ? structuredClone(approvedQuote) : undefined;
  const wallet = gatedWallet(
    createWalletService(
      {
        ...soapboxWalletConfig(mainWallet),
        cdpApiKeyId: auth.apiKeyId,
        cdpApiKeySecret: auth.apiKeySecret,
      },
      {
        walletSecret: auth.walletSecret,
        rpcUrl: process.env.BITTERBOT_SOAPBOX_RPC_URL ?? "https://sepolia.base.org",
        accountName: identity?.name ?? SOAPBOX_ACCOUNT_NAME,
        expectedAddress: identity?.address,
      },
    ),
    { origin: "rpc", purpose: "Owner-approved Compute job on Base Sepolia" },
  );
  return {
    ...wallet,
    async fundSoapbox(quote: SoapboxPaymentQuote) {
      assertApprovedSoapboxQuote(approved, quote);
      const current = await readComputeIdentity();
      if (current) await assertWalletSeparation(current, mainWallet);
      await appendFile(
        path.join(soapboxWalletDirectory, "funding-approvals.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          decision: "user_reviewed",
          chain_id: quote.chain_id,
          key: quote.key,
          escrow: quote.escrow,
          operator: quote.operator,
          amount_microusdc: quote.amount_microusdc,
        }) + "\n",
        { mode: 0o600 },
      );
      return wallet.fundSoapbox!(quote);
    },
  };
}

/**
 * The one funding entry point for an owner-approved Compute quote outside the
 * Control UI RPC. Callers hand over the exact quote the owner reviewed; the
 * wallet re-asserts it, runs the shared spend gate and records the approval.
 * PLAN-47 I4 keeps every value-moving call inside this file, so the compute
 * backend's signer calls this instead of touching the wallet directly.
 */
export async function fundApprovedSoapboxQuote(
  mainWallet: WalletConfig | undefined,
  quote: SoapboxPaymentQuote,
): Promise<{ status: string; txHash: string | null }> {
  const wallet = await createSoapboxWallet(mainWallet, quote);
  return wallet.fundSoapbox!(quote);
}

export type SoapboxWalletAuthentication = {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
};
const credentialsFile = path.join(soapboxWalletDirectory, "credentials.json");

export async function soapboxWalletAuthentication(
  mainWallet?: WalletConfig,
): Promise<SoapboxWalletAuthentication> {
  try {
    return JSON.parse(await readFile(credentialsFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    apiKeyId: mainWallet?.cdpApiKeyId ?? process.env.CDP_API_KEY_ID ?? "",
    apiKeySecret: mainWallet?.cdpApiKeySecret ?? process.env.CDP_API_KEY_SECRET ?? "",
    walletSecret: process.env.CDP_WALLET_SECRET ?? "",
  };
}

async function readComputeIdentity(): Promise<{ name: string; address: string } | null> {
  try {
    const stored = JSON.parse(
      await readFile(path.join(soapboxWalletDirectory, "wallet-data.json"), "utf8"),
    );
    if (
      ![SOAPBOX_ACCOUNT_NAME, LEGACY_ACCOUNT_NAME].includes(stored.name) ||
      !/^0x[\da-f]{40}$/i.test(stored.address)
    )
      throw new Error("Invalid Compute test wallet identity");
    return { name: stored.name, address: stored.address };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertWalletSeparation(
  identity: { name: string; address: string },
  mainWallet?: WalletConfig,
): Promise<void> {
  if (identity.name === LEGACY_ACCOUNT_NAME && mainWallet?.network === "base-sepolia")
    throw new Error(
      "Legacy Compute identity conflicts with the main testnet account; migrate Compute before continuing",
    );
  const mainDirectory = mainWallet?.walletStorePath ?? path.join(homedir(), ".bitterbot", "wallet");
  let main: { address?: string; ownerAddress?: string };
  try {
    main = JSON.parse(await readFile(path.join(mainDirectory, "wallet-data.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // oxlint-disable-next-line preserve-caught-error -- Wallet file errors may include private data; intentionally discard the cause.
    throw new Error("Main wallet identity could not be checked");
  }
  if (
    [main.address, main.ownerAddress].some(
      (address) =>
        typeof address === "string" && address.toLowerCase() === identity.address.toLowerCase(),
    )
  )
    throw new Error("Compute and main wallet addresses must be separate");
}

export async function soapboxWalletIdentity(mainWallet?: WalletConfig): Promise<string | null> {
  const identity = await readComputeIdentity();
  if (identity) await assertWalletSeparation(identity, mainWallet);
  return identity?.address ?? null;
}

/** Provision the test account without loading AgentKit or changing the main wallet/env. */
export async function initializeSoapboxWallet(
  mainWallet?: WalletConfig,
  supplied?: SoapboxWalletAuthentication,
): Promise<string> {
  const auth = supplied ?? (await soapboxWalletAuthentication(mainWallet));
  if (
    Object.values(auth).length !== 3 ||
    ![auth.apiKeyId, auth.apiKeySecret, auth.walletSecret].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 16384,
    )
  )
    throw new Error("Enter all three CDP credentials for the test wallet");
  const existing = await readComputeIdentity();
  if (existing) await assertWalletSeparation(existing, mainWallet);
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const account = await new CdpClient(auth).evm.getOrCreateAccount({
    name: existing?.name ?? SOAPBOX_ACCOUNT_NAME,
  });
  if (existing && existing.address.toLowerCase() !== account.address.toLowerCase())
    throw new Error("These credentials belong to a different test wallet");
  await assertWalletSeparation(
    { name: existing?.name ?? SOAPBOX_ACCOUNT_NAME, address: account.address },
    mainWallet,
  );
  // Also enforce separation from a user-configured main-wallet store before writing.
  await createSoapboxWallet(mainWallet);
  const save = async (file: string, value: unknown) => {
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  if (supplied) await save(credentialsFile, auth);
  await save(path.join(soapboxWalletDirectory, "wallet-data.json"), {
    name: existing?.name ?? SOAPBOX_ACCOUNT_NAME,
    address: account.address,
    ownerAddress: account.address,
  });
  return account.address;
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
    if (
      ![SOAPBOX_ACCOUNT_NAME, LEGACY_ACCOUNT_NAME].includes(stored.name) ||
      !/^0x[\da-f]{40}$/i.test(stored.address)
    )
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
