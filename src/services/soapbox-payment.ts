import { createHash } from "node:crypto";
import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { SoapboxPaymentQuote } from "../infra/soapbox-client.js";
export type { SoapboxPaymentQuote } from "../infra/soapbox-client.js";

export const soapboxEscrowAbi = parseAbi([
  "function token() view returns (address)",
  "function jobs(bytes32) view returns (address buyer,address operator,uint256 amount,uint256 expires,uint256 state,bytes32 result)",
  "function fund(bytes32,address,uint256,uint256)",
]);
const approveAbi = parseAbi(["function approve(address,uint256) returns (bool)"]);
const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export function validateSoapboxQuote(quote: SoapboxPaymentQuote, buyer: string, network: string) {
  if (network !== "base-sepolia" || quote.chain_id !== 84532)
    throw new Error("Soapbox payments currently require Base Sepolia");
  for (const value of [quote.token, quote.escrow, quote.buyer, quote.operator]) {
    if (!/^0x[\da-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value))
      throw new Error("Invalid payment address");
  }
  if (
    quote.token.toLowerCase() !== usdc.toLowerCase() ||
    quote.buyer.toLowerCase() !== buyer.toLowerCase()
  )
    throw new Error("Quote token or buyer does not match this wallet");
  if (
    !/^0x[\da-f]{64}$/i.test(quote.key) ||
    !Number.isSafeInteger(quote.amount_microusdc) ||
    quote.amount_microusdc <= 0 ||
    quote.amount_microusdc > 100_000_000 ||
    !Number.isSafeInteger(quote.expires) ||
    quote.expires < Date.now() / 1000 + 120 ||
    quote.expires > Date.now() / 1000 + 86400
  )
    throw new Error("Invalid or expired payment quote");
}

/** Exact-amount approval to an operator-pinned escrow. No arbitrary contract calls reach the wallet. */
export async function fundSoapboxEscrow(options: {
  quote: SoapboxPaymentQuote;
  buyer: string;
  network: string;
  reserve: () => Promise<void>;
  send: (transaction: { to: Hex; data: Hex; value: bigint }) => Promise<Hex>;
  env?: NodeJS.ProcessEnv;
}) {
  const { quote, buyer, network, send, reserve, env = process.env } = options;
  validateSoapboxQuote(quote, buyer, network);
  if (
    env.BITTERBOT_SOAPBOX_ESCROW?.toLowerCase() !== quote.escrow.toLowerCase() ||
    !/^[\da-f]{64}$/.test(env.BITTERBOT_SOAPBOX_ESCROW_CODE_SHA256 ?? "")
  )
    throw new Error("Operator must pin the escrow address and deployed bytecode hash");
  const rpcUrl = env.BITTERBOT_SOAPBOX_RPC_URL ?? "https://sepolia.base.org";
  if (new URL(rpcUrl).protocol !== "https:") throw new Error("Payment RPC requires HTTPS");
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  if ((await client.getChainId()) !== 84532) throw new Error("Wrong payment chain");
  const address = quote.escrow as Hex;
  const code = await client.getCode({ address });
  if (
    !code ||
    createHash("sha256")
      .update(Buffer.from(code.slice(2), "hex"))
      .digest("hex") !== env.BITTERBOT_SOAPBOX_ESCROW_CODE_SHA256
  )
    throw new Error("Escrow bytecode does not match the operator's pin");
  const token = await client.readContract({
    address,
    abi: soapboxEscrowAbi,
    functionName: "token",
  });
  if (token.toLowerCase() !== usdc.toLowerCase()) throw new Error("Escrow token mismatch");
  const key = quote.key as Hex;
  const existing = await client.readContract({
    address,
    abi: soapboxEscrowAbi,
    functionName: "jobs",
    args: [key],
  });
  if (existing[4] !== 0n) {
    if (
      existing[0].toLowerCase() !== buyer.toLowerCase() ||
      existing[1].toLowerCase() !== quote.operator.toLowerCase() ||
      existing[2] !== BigInt(quote.amount_microusdc) ||
      existing[3] !== BigInt(quote.expires)
    )
      throw new Error("Existing escrow does not match quote");
    return { status: "already_funded", txHash: null };
  }
  // Persist a spend reservation before signing. Ambiguous broadcasts keep the reservation.
  await reserve();
  const approval = await send({
    to: usdc,
    value: 0n,
    data: encodeFunctionData({
      abi: approveAbi,
      functionName: "approve",
      args: [address, BigInt(quote.amount_microusdc)],
    }),
  });
  const approved = await client.waitForTransactionReceipt({ hash: approval, confirmations: 2 });
  if (approved.status !== "success") throw new Error("USDC approval reverted");
  const txHash = await send({
    to: address,
    value: 0n,
    data: encodeFunctionData({
      abi: soapboxEscrowAbi,
      functionName: "fund",
      args: [key, quote.operator as Hex, BigInt(quote.amount_microusdc), BigInt(quote.expires)],
    }),
  });
  const funded = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (funded.status !== "success") throw new Error("Escrow funding reverted");
  return { status: "funded", txHash };
}
