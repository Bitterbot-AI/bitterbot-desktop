/**
 * PLAN-29 Phase 4 / PLAN-26 Phase 3: production adapters for the Aubaine
 * settlement interfaces, backed by the node's CDP Server Wallet.
 *
 * The 2026-07-03 spike proved both legs on this exact wallet class:
 *  - SIGN: `EvmServerAccount.signTypedData` (cdp-sdk 1.48.2) signs
 *    arbitrary EIP-712, and production x402 already signs EIP-3009
 *    authorizations through it.
 *  - CAPTURE: `transferWithAuthorization` is permissionless — USDC
 *    ecrecovers the funder's signature; the submitting account only pays
 *    gas. We submit through the same AgentKit provider `sendUsdc` uses.
 *
 * Gotchas encoded here so nobody relearns them on mainnet:
 *  - USDC's EIP-712 domain name differs per network: "USD Coin" on Base
 *    mainnet, "USDC" on Base Sepolia. Version is "2" on both.
 *  - One (from, nonce) pair is one authorization; nonces are random 32
 *    bytes, never sequential.
 *  - A signer can cancelAuthorization on-chain before capture, so
 *    capture is best-effort by design (confirm-then-capture upstream).
 */

import crypto from "node:crypto";
import type { Eip3009Authorization, Eip3009Signer, SettlementExecutor } from "./settlement.js";

export const USDC_BY_NETWORK: Record<
  "base" | "base-sepolia",
  { contract: `0x${string}`; chainId: number; domainName: string }
> = {
  base: {
    contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chainId: 8453,
    domainName: "USD Coin",
  },
  "base-sepolia": {
    contract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    chainId: 84532,
    domainName: "USDC",
  },
};

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Narrow view of the CDP EvmServerAccount we need (structural, no SDK import). */
export type TypedDataSigner = {
  address: string;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
};

export function randomNonce32(): `0x${string}` {
  return ("0x" + crypto.randomBytes(32).toString("hex")) as `0x${string}`;
}

/**
 * Eip3009Signer over a CDP server account. The account is injected (tests
 * pass a fake; production resolves it via `resolveCdpAccount`).
 */
export function createCdpEip3009Signer(
  account: TypedDataSigner,
  network: "base" | "base-sepolia",
): Eip3009Signer {
  const usdc = USDC_BY_NETWORK[network];
  return {
    walletAddress: () => account.address,
    async signTransfer(params: Omit<Eip3009Authorization, "signature">) {
      const signature = await account.signTypedData({
        domain: {
          name: usdc.domainName,
          version: "2",
          chainId: usdc.chainId,
          verifyingContract: usdc.contract,
        },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: params.from,
          to: params.to,
          value: BigInt(params.value),
          validAfter: BigInt(params.validAfter),
          validBefore: BigInt(params.validBefore),
          nonce: params.nonce,
        },
      });
      return { ...params, signature };
    },
  };
}

/** Resolve the node's CDP server account (production path, lazy SDK import). */
export async function resolveCdpAccount(
  network: "base" | "base-sepolia",
): Promise<TypedDataSigner> {
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error("Missing CDP credentials for EIP-3009 signing");
  }
  const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
  const account = await cdp.evm.getOrCreateAccount({ name: `bitterbot-owner-${network}` });
  return account as unknown as TypedDataSigner;
}

/** Narrow view of the transaction submitter (AgentKit provider shape). */
export type TxSender = {
  sendTransaction(tx: { to: `0x${string}`; value: bigint; data: `0x${string}` }): Promise<string>;
};

/**
 * SettlementExecutor that captures a signed authorization on-chain via the
 * v,r,s variant of transferWithAuthorization. The submitter pays gas only;
 * value moves from the authorization's signer.
 */
export function createCaptureExecutor(
  sender: TxSender,
  network: "base" | "base-sepolia",
): SettlementExecutor {
  const usdc = USDC_BY_NETWORK[network];
  return {
    async capture(auth: Eip3009Authorization): Promise<{ txHash: string }> {
      const { encodeFunctionData, parseSignature } = await import("viem");
      const sig = parseSignature(auth.signature as `0x${string}`);
      const data = encodeFunctionData({
        abi: [
          {
            name: "transferWithAuthorization",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
              { name: "v", type: "uint8" },
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
            ],
            outputs: [],
          },
        ],
        functionName: "transferWithAuthorization",
        args: [
          auth.from as `0x${string}`,
          auth.to as `0x${string}`,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce as `0x${string}`,
          Number(sig.v ?? (sig.yParity === 0 ? 27n : 28n)),
          sig.r,
          sig.s,
        ],
      });
      const txHash = await sender.sendTransaction({ to: usdc.contract, value: 0n, data });
      return { txHash };
    },
  };
}
