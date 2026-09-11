/**
 * ERC-8004 Agent Identity — onchain identity and reputation on Base.
 *
 * Registers the agent as an ERC-8004 entity, enabling:
 * - Universal agent discovery via NFT lookup
 * - Onchain reputation from transaction feedback
 * - Verifiable skill claims backed by execution metrics
 *
 * Contract addresses (canonical deployments):
 *   Base mainnet:  Identity 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *                  Reputation 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *   Base Sepolia:  Identity 0x8004A818BFB912233c491871b3d84c89A494BD9e
 *                  Reputation 0x8004B663056A597Dffe9eCcC1965A193B7388713
 *
 * Conditional: only activate if registry has meaningful traction (>100 agents).
 *
 * Plan 8, Phase 5.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("erc8004");

// Canonical ERC-8004 registry addresses
const REGISTRIES = {
  base: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const,
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const,
  },
  "base-sepolia": {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const,
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const,
  },
} as const;

// Minimal ABI fragments for the functions we call
const IDENTITY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "setAgentURI",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const REPUTATION_ABI = [
  {
    name: "giveFeedback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "getSummary",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
] as const;

/** keccak256("Transfer(address,address,uint256)") — the ERC-721 mint/transfer topic. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Minimal receipt-reader (a viem PublicClient satisfies this) for reading back a mint. */
export interface ReceiptReader {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    logs: Array<{ address?: string; topics: Array<string | undefined> }>;
  }>;
}

export type ERC8004Network = "base" | "base-sepolia";

export interface ERC8004Config {
  network: ERC8004Network;
  agentCardUrl: string;
  minAgentsForTraction?: number;
}

/**
 * Registration file schema per ERC-8004 spec.
 * Hosted at the agentURI and pointed to by the NFT metadata.
 */
export interface AgentRegistrationFile {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  image?: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{
    agentId: number;
    agentRegistry: string; // format: eip155:{chainId}:{address}
  }>;
  supportedTrust: Array<"reputation" | "crypto-economic" | "tee-attestation">;
}

export class AgentIdentityService {
  private readonly network: ERC8004Network;
  private readonly registryAddresses: {
    readonly identity: `0x${string}`;
    readonly reputation: `0x${string}`;
  };
  private agentId: bigint | null = null;

  constructor(private readonly config: ERC8004Config) {
    this.network = config.network;
    this.registryAddresses = REGISTRIES[this.network];
  }

  /**
   * Check if the ERC-8004 ecosystem has meaningful traction.
   * Returns false if fewer than minAgents are registered — defer integration.
   */
  async checkEcosystemTraction(
    minAgents?: number,
  ): Promise<{ hasTraction: boolean; totalAgents: number }> {
    const threshold = minAgents ?? this.config.minAgentsForTraction ?? 100;
    try {
      const { createPublicClient, http } = await import("viem");
      const { base, baseSepolia } = await import("viem/chains");
      const chain = this.network === "base" ? base : baseSepolia;

      const client = createPublicClient({ chain, transport: http() });
      const totalSupply = (await client.readContract({
        address: this.registryAddresses.identity,
        abi: IDENTITY_ABI,
        functionName: "totalSupply",
      })) as bigint;

      const count = Number(totalSupply);
      log.debug("ERC-8004 traction check", {
        network: this.network,
        totalAgents: count,
        threshold,
      });
      return { hasTraction: count >= threshold, totalAgents: count };
    } catch (err) {
      log.warn(`ERC-8004 traction check failed: ${String(err)}`);
      return { hasTraction: false, totalAgents: 0 };
    }
  }

  /**
   * Register the agent on the ERC-8004 Identity Registry.
   * The agentURI should point to the Agent Card / registration file.
   * Requires a funded wallet (gas cost ~$0.05-0.20 on Base).
   *
   * When a `publicClient` is supplied, the minted agentId (ERC-721 tokenId) is
   * read back from the registration receipt and returned/stored — so the
   * operator gets the concrete tokenId to put in `a2a.erc8004.tokenId` instead
   * of the old "pending" placeholder (PLAN-47 Phase 3). Without a publicClient
   * the behavior is unchanged (returns "pending").
   */
  async register(
    walletClient: {
      writeContract(args: {
        address: string;
        abi: readonly unknown[];
        functionName: string;
        args: unknown[];
      }): Promise<string>;
    },
    opts?: { publicClient?: ReceiptReader },
  ): Promise<{ agentId: string; txHash: string }> {
    const txHash = await walletClient.writeContract({
      address: this.registryAddresses.identity,
      abi: IDENTITY_ABI,
      functionName: "register",
      args: [this.config.agentCardUrl],
    });

    let agentId = "pending";
    if (opts?.publicClient) {
      const minted = await this.readMintedAgentId(opts.publicClient, txHash);
      if (minted !== null) {
        this.agentId = minted;
        agentId = minted.toString();
      }
    }
    log.info("ERC-8004 agent registered", {
      txHash,
      agentId,
      agentCardUrl: this.config.agentCardUrl,
    });
    return { agentId, txHash };
  }

  /**
   * Read the minted tokenId from a registration receipt. The Identity Registry
   * is an ERC-721, so registration emits a standard Transfer(from=0x0, to,
   * tokenId) event from the registry contract; tokenId is the 4th topic.
   * Returns null if no such mint log is found (e.g. receipt not yet available).
   */
  async readMintedAgentId(publicClient: ReceiptReader, txHash: string): Promise<bigint | null> {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const identity = this.registryAddresses.identity.toLowerCase();
      const zero32 = "0x" + "0".repeat(64);
      for (const logEntry of receipt.logs) {
        if (logEntry.address?.toLowerCase() !== identity) continue;
        if (logEntry.topics[0] !== TRANSFER_TOPIC) continue;
        // Mint = Transfer from the zero address. tokenId is the indexed 4th topic.
        if (logEntry.topics[1]?.toLowerCase() !== zero32) continue;
        const tokenIdTopic = logEntry.topics[3];
        if (tokenIdTopic) return BigInt(tokenIdTopic);
      }
      return null;
    } catch (err) {
      log.debug(`could not read minted agentId: ${String(err)}`);
      return null;
    }
  }

  /**
   * Record feedback for another agent on the Reputation Registry.
   * Called after a successful (or failed) A2A skill purchase.
   */
  async giveFeedback(
    walletClient: {
      writeContract(args: {
        address: string;
        abi: readonly unknown[];
        functionName: string;
        args: unknown[];
      }): Promise<string>;
    },
    params: {
      agentId: bigint;
      value: number;
      tag1: string;
      tag2?: string;
      endpoint?: string;
      /** Optional offchain feedback document URI. */
      feedbackURI?: string;
      /** Optional offchain feedback content; its keccak256 becomes feedbackHash. */
      feedbackContent?: string;
    },
  ): Promise<string> {
    // value is -1.0 to 1.0, stored as int128 with 2 decimals
    const scaledValue = BigInt(Math.round(params.value * 100));
    // feedbackHash binds the onchain attestation to the offchain feedback
    // document. When content is supplied, hash it (keccak256, the EVM norm);
    // a zero hash is only correct when there is genuinely no offchain detail
    // (PLAN-47 Phase 3 — was previously always zero).
    let feedbackHash = "0x" + "0".repeat(64);
    if (params.feedbackContent) {
      const { keccak256, toHex } = await import("viem");
      feedbackHash = keccak256(toHex(params.feedbackContent));
    }

    const txHash = await walletClient.writeContract({
      address: this.registryAddresses.reputation,
      abi: REPUTATION_ABI,
      functionName: "giveFeedback",
      args: [
        params.agentId,
        scaledValue,
        2, // valueDecimals
        params.tag1,
        params.tag2 ?? "",
        params.endpoint ?? "",
        params.feedbackURI ?? "",
        feedbackHash,
      ],
    });

    log.debug("ERC-8004 feedback given", {
      agentId: String(params.agentId),
      value: params.value,
      txHash,
    });
    return txHash;
  }

  /**
   * Query another agent's reputation from the onchain Reputation Registry.
   */
  async getReputation(agentId: bigint): Promise<{
    count: number;
    averageScore: number;
  }> {
    try {
      const { createPublicClient, http } = await import("viem");
      const { base, baseSepolia } = await import("viem/chains");
      const chain = this.network === "base" ? base : baseSepolia;

      const client = createPublicClient({ chain, transport: http() });
      const [count, summaryValue, decimals] = (await client.readContract({
        address: this.registryAddresses.reputation,
        abi: REPUTATION_ABI,
        functionName: "getSummary",
        args: [agentId, [], "", ""], // All clients, no tag filter
      })) as [bigint, bigint, number];

      const avgScore =
        decimals > 0 ? Number(summaryValue) / Math.pow(10, decimals) : Number(summaryValue);

      return { count: Number(count), averageScore: avgScore };
    } catch (err) {
      log.debug(`ERC-8004 reputation query failed: ${String(err)}`);
      return { count: 0, averageScore: 0 };
    }
  }

  /**
   * Build the Agent Registration File per ERC-8004 spec.
   * This is hosted at the agentURI and pointed to by the NFT.
   */
  buildRegistrationFile(params: {
    name: string;
    description: string;
    agentId: number;
    services: Array<{ name: string; endpoint: string }>;
  }): AgentRegistrationFile {
    const chainId = this.network === "base" ? 8453 : 84532;
    return {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: params.name,
      description: params.description,
      services: params.services,
      x402Support: true,
      active: true,
      registrations: [
        {
          agentId: params.agentId,
          agentRegistry: `eip155:${chainId}:${this.registryAddresses.identity}`,
        },
      ],
      supportedTrust: ["reputation"],
    };
  }

  /** Get the configured registry addresses. */
  getRegistryAddresses(): { identity: string; reputation: string } {
    return { ...this.registryAddresses };
  }

  /** Get the stored agent ID (set after registration). */
  getAgentId(): bigint | null {
    return this.agentId;
  }

  /** Set the agent ID (from persisted config after registration). */
  setAgentId(id: bigint): void {
    this.agentId = id;
  }
}

/** Feedback args ready to pass to `giveFeedback`. */
export interface ReputationFeedback {
  value: number;
  tag1: string;
  tag2: string;
}

/**
 * Bridge an internal reputation summary (Forage delivery / commerce outcomes)
 * into ERC-8004 Reputation feedback (PLAN-47 Phase 3). Maps a success rate in
 * [0,1] to the registry's [-1,1] value scale. Returns null below a minimum
 * sample size so we never project a confident onchain score from thin data
 * (the plan's "keep the reputation path conservative" caveat).
 */
export function buildReputationFeedback(
  summary: { successRate: number; sampleSize: number },
  opts?: { minSample?: number; tag1?: string },
): ReputationFeedback | null {
  const minSample = opts?.minSample ?? 5;
  if (!Number.isFinite(summary.successRate) || summary.sampleSize < minSample) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, summary.successRate));
  return {
    value: clamped * 2 - 1, // [0,1] -> [-1,1]
    tag1: opts?.tag1 ?? "commerce",
    tag2: `n=${summary.sampleSize}`,
  };
}
