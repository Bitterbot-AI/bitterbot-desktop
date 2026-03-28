import type { WalletConfig } from "../config/types.wallet.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import lockfile from "proper-lockfile";

export type BalanceResult = {
  token: string;
  balance: string;
  usdValue?: string;
};

export type SendResult = {
  txHash: string;
  status: string;
};

export type TradeResult = {
  txHash: string;
  status: string;
};

export type TransactionRecord = {
  txHash: string;
  type: string;
  amount: string;
  token: string;
  timestamp: number;
};

export type SendUsdcOptions = {
  /** When provided, use this exact smallest-unit amount instead of converting from USD float. */
  rawSmallestUnit?: bigint;
};

export type X402PaymentResult = {
  success: boolean;
  statusCode?: number;
  content?: string;
  contentType?: string;
  amountPaid?: number;
  txHash?: string;
  error?: string;
};

export interface WalletService {
  getAddress(): Promise<string>;
  getBalance(token?: string): Promise<BalanceResult>;
  sendUsdc(to: string, amount: number, opts?: SendUsdcOptions): Promise<SendResult>;
  trade(fromToken: string, toToken: string, amount: number): Promise<TradeResult>;
  getTransactionHistory(limit?: number): Promise<TransactionRecord[]>;
  getFundingUrl(): Promise<string>;
  getNetwork(): string;
  payForResource(resourceUrl: string, amountUsdc: number): Promise<X402PaymentResult>;
}

const DEFAULT_WALLET_STORE = path.join(os.homedir(), ".bitterbot", "wallet");

const NETWORK_IDS: Record<string, string> = {
  base: "base-mainnet",
  "base-sepolia": "base-sepolia",
};

const TOKEN_CONTRACTS: Record<string, Record<string, string>> = {
  base: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};

// Derived from TOKEN_CONTRACTS — single source of truth
const USDC_CONTRACTS: Record<string, string> = Object.fromEntries(
  Object.entries(TOKEN_CONTRACTS)
    .filter(([, tokens]) => tokens.USDC)
    .map(([net, tokens]) => [net, tokens.USDC]),
);

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  DAI: 18,
};

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function createWalletService(config: WalletConfig): WalletService {
  const network = config.network ?? "base-sepolia";
  const networkId = NETWORK_IDS[network] ?? "base-sepolia";
  const storePath = config.walletStorePath ?? DEFAULT_WALLET_STORE;
  const perTxCap = config.perTransactionCapUsd ?? 25;

  // Lazily initialized wallet provider
  let walletProviderPromise: Promise<import("@coinbase/agentkit").CdpWalletProvider> | null = null;

  async function ensureStoreDir(): Promise<void> {
    await fs.mkdir(storePath, { recursive: true });
  }

  async function loadWalletData(): Promise<string | undefined> {
    try {
      const filePath = path.join(storePath, "wallet-data.json");
      const data = await fs.readFile(filePath, "utf-8");
      return data;
    } catch {
      return undefined;
    }
  }

  async function saveWalletData(data: string): Promise<void> {
    await ensureStoreDir();
    const filePath = path.join(storePath, "wallet-data.json");
    await fs.writeFile(filePath, data, "utf-8");
  }

  async function getProvider(): Promise<import("@coinbase/agentkit").CdpWalletProvider> {
    if (!walletProviderPromise) {
      walletProviderPromise = initProvider();
    }
    return walletProviderPromise;
  }

  async function initProvider(): Promise<import("@coinbase/agentkit").CdpWalletProvider> {
    const { CdpWalletProvider } = await import("@coinbase/agentkit");

    const existingData = await loadWalletData();

    const provider = await CdpWalletProvider.configureWithWallet({
      apiKeyName: config.cdpApiKeyId ?? process.env.CDP_API_KEY_ID ?? "",
      apiKeyPrivateKey: config.cdpApiKeySecret ?? process.env.CDP_API_KEY_SECRET ?? "",
      cdpWalletData: existingData,
      networkId,
    });

    // Persist wallet data for future sessions
    const exportedData = await provider.exportWallet();
    if (exportedData) {
      await saveWalletData(JSON.stringify(exportedData));
    }

    return provider;
  }

  function validateTransactionAmount(amount: number): void {
    if (amount <= 0) {
      throw new Error("Transaction amount must be positive");
    }
    if (amount > perTxCap) {
      throw new Error(
        `Transaction amount $${amount} exceeds per-transaction cap of $${perTxCap}`,
      );
    }
  }

  async function recordTransaction(record: TransactionRecord): Promise<void> {
    await ensureStoreDir();
    const historyPath = path.join(storePath, "tx-history.json");

    // Ensure the file exists before locking (proper-lockfile requires it)
    try {
      await fs.access(historyPath);
    } catch {
      await fs.writeFile(historyPath, "[]", "utf-8");
    }

    const release = await lockfile.lock(historyPath, {
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
      stale: 10_000,
    });
    try {
      let history: TransactionRecord[] = [];
      try {
        history = JSON.parse(await fs.readFile(historyPath, "utf-8"));
      } catch {}
      history.push(record);
      if (history.length > 500) history = history.slice(-500);
      await fs.writeFile(historyPath, JSON.stringify(history, null, 2), "utf-8");
    } finally {
      await release();
    }
  }

  function formatBalance(raw: bigint, decimals: number): string {
    if (raw < 0n) return "-" + formatBalance(-raw, decimals);
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  }

  return {
    async getAddress(): Promise<string> {
      const provider = await getProvider();
      return provider.getAddress();
    },

    async getBalance(token?: string): Promise<BalanceResult> {
      const provider = await getProvider();
      const tokenSymbol = (token ?? "ETH").toUpperCase();

      try {
        if (tokenSymbol === "ETH") {
          const balance = await provider.getBalance();
          return {
            token: tokenSymbol,
            balance: formatBalance(balance, 18),
          };
        }

        // ERC-20 token balance via readContract
        const contracts = TOKEN_CONTRACTS[network];
        const contractAddress = contracts?.[tokenSymbol];
        if (!contractAddress) {
          throw new Error(`No contract address for ${tokenSymbol} on ${network}`);
        }

        const walletAddress = provider.getAddress();
        const rawBalance = await provider.readContract({
          address: contractAddress as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [walletAddress as `0x${string}`],
        });

        const decimals = TOKEN_DECIMALS[tokenSymbol] ?? 18;
        return {
          token: tokenSymbol,
          balance: formatBalance(BigInt(rawBalance), decimals),
        };
      } catch (err) {
        throw new Error(
          `Failed to get balance for ${tokenSymbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async sendUsdc(to: string, amount: number, opts?: SendUsdcOptions): Promise<SendResult> {
      validateTransactionAmount(amount);
      const provider = await getProvider();

      const usdcContract = USDC_CONTRACTS[network];
      if (!usdcContract) {
        throw new Error(`No USDC contract for network: ${network}`);
      }

      try {
        const smallestUnit = opts?.rawSmallestUnit ?? BigInt(Math.round(amount * 1e6));
        const tx = await provider.sendTransaction({
          to: usdcContract as `0x${string}`,
          value: BigInt(0),
          data: encodeSendUsdcData(to, smallestUnit),
        });

        await recordTransaction({
          txHash: tx,
          type: "send",
          amount: amount.toString(),
          token: "USDC",
          timestamp: Date.now(),
        });

        return {
          txHash: tx,
          status: "pending",
        };
      } catch (err) {
        throw new Error(
          `Failed to send USDC: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async trade(fromToken: string, toToken: string, _amount: number): Promise<TradeResult> {
      throw new Error(
        `Token swaps (${fromToken} \u2192 ${toToken}) are not yet implemented.`,
      );
    },

    async getTransactionHistory(limit?: number): Promise<TransactionRecord[]> {
      const historyPath = path.join(storePath, "tx-history.json");
      try {
        const raw = await fs.readFile(historyPath, "utf-8");
        const history: TransactionRecord[] = JSON.parse(raw);
        const maxResults = limit ?? 10;
        return history.slice(-maxResults);
      } catch {
        return [];
      }
    },

    async getFundingUrl(): Promise<string> {
      if (config.stripe?.enabled) {
        return `/wallet/fund`;
      }
      const provider = await getProvider();
      const address = provider.getAddress();
      if (network === "base-sepolia") {
        return `https://portal.cdp.coinbase.com/products/faucet?address=${address}&network=base-sepolia`;
      }
      return `https://pay.coinbase.com/buy?appId=bitterbot&addresses={"${address}":["base"]}&assets=["USDC"]`;
    },

    getNetwork(): string {
      return network;
    },

    async payForResource(resourceUrl: string, amountUsdc: number): Promise<X402PaymentResult> {
      validateTransactionAmount(amountUsdc);
      const provider = await getProvider();
      const address = provider.getAddress();

      try {
        // Build x402 payment payload
        const smallestUnit = BigInt(Math.round(amountUsdc * 1e6));
        const usdcContract = USDC_CONTRACTS[network];
        if (!usdcContract) {
          return { success: false, error: `No USDC contract for network: ${network}` };
        }

        // Sign x402 payment — transfer USDC to resource facilitator
        const paymentPayload = JSON.stringify({
          resource: resourceUrl,
          amount: smallestUnit.toString(),
          token: "USDC",
          network,
          payer: address,
        });
        const signature = await provider.signMessage(paymentPayload);

        // Encode payment header (base64 JSON)
        const headerPayload = JSON.stringify({
          signature,
          payment: {
            resource: resourceUrl,
            amount: smallestUnit.toString(),
            token: "USDC",
            network,
          },
          address,
        });
        const paymentHeader = Buffer.from(headerPayload).toString("base64");

        // Make HTTP request with x402 payment header
        const response = await fetch(resourceUrl, {
          headers: {
            "X-PAYMENT": paymentHeader,
            "Accept": "application/json, text/plain, */*",
          },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();

        if (response.ok) {
          // Record successful payment
          await recordTransaction({
            txHash: `x402-${Date.now().toString(36)}`,
            type: "x402_payment",
            amount: amountUsdc.toString(),
            token: "USDC",
            timestamp: Date.now(),
          });

          return {
            success: true,
            statusCode: response.status,
            content: body.slice(0, 10_000),
            contentType,
            amountPaid: amountUsdc,
          };
        }

        return {
          success: false,
          statusCode: response.status,
          error: `Resource returned HTTP ${response.status}: ${body.slice(0, 500)}`,
        };
      } catch (err) {
        return {
          success: false,
          error: `x402 payment failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

function encodeSendUsdcData(to: string, amountSmallestUnit: bigint): `0x${string}` {
  // ERC-20 transfer(address,uint256) function selector: 0xa9059cbb
  const recipient = to.toLowerCase().replace("0x", "").padStart(64, "0");
  const value = amountSmallestUnit.toString(16).padStart(64, "0");
  return `0xa9059cbb${recipient}${value}` as `0x${string}`;
}

// Re-export USDC contracts for use by other modules
export { USDC_CONTRACTS };
