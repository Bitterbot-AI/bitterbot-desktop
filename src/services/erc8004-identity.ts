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
  "base": {
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
  private readonly registryAddresses: { readonly identity: `0x${string}`; readonly reputation: `0x${string}` };
  private agentId: bigint | null = null;

  constructor(private readonly config: ERC8004Config) {
    this.network = config.network;
    this.registryAddresses = REGISTRIES[this.network];
  }

  /**
   * Check if the ERC-8004 ecosystem has meaningful traction.
   * Returns false if fewer than minAgents are registered — defer integration.
   */
  async checkEcosystemTraction(minAgents?: number): Promise<{ hasTraction: boolean; totalAgents: number }> {
    const threshold = minAgents ?? this.config.minAgentsForTraction ?? 100;
    try {
      const { createPublicClient, http } = await import("viem");
      const { base, baseSepolia } = await import("viem/chains");
      const chain = this.network === "base" ? base : baseSepolia;

      const client = createPublicClient({ chain, transport: http() });
      const totalSupply = await client.readContract({
        address: this.registryAddresses.identity,
        abi: IDENTITY_ABI,
        functionName: "totalSupply",
      }) as bigint;

      const count = Number(totalSupply);
      log.debug("ERC-8004 traction check", { network: this.network, totalAgents: count, threshold });
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
   */
  async register(walletClient: {
    writeContract(args: {
      address: string; abi: readonly unknown[]; functionName: string; args: unknown[];
    }): Promise<string>;
  }): Promise<{ agentId: string; txHash: string }> {
    const txHash = await walletClient.writeContract({
      address: this.registryAddresses.identity,
      abi: IDENTITY_ABI,
      functionName: "register",
      args: [this.config.agentCardUrl],
    });

    log.info("ERC-8004 agent registered", { txHash, agentCardUrl: this.config.agentCardUrl });
    return { agentId: "pending", txHash };
  }

  /**
   * Record feedback for another agent on the Reputation Registry.
   * Called after a successful (or failed) A2A skill purchase.
   */
  async giveFeedback(
    walletClient: {
      writeContract(args: {
        address: string; abi: readonly unknown[]; functionName: string; args: unknown[];
      }): Promise<string>;
    },
    params: {
      agentId: bigint;
      value: number;
      tag1: string;
      tag2?: string;
      endpoint?: string;
    },
  ): Promise<string> {
    // value is -1.0 to 1.0, stored as int128 with 2 decimals
    const scaledValue = BigInt(Math.round(params.value * 100));
    const feedbackHash = "0x" + "0".repeat(64); // placeholder — no offchain URI

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
        "", // feedbackURI — offchain detail (optional)
        feedbackHash,
      ],
    });

    log.debug("ERC-8004 feedback given", { agentId: String(params.agentId), value: params.value, txHash });
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
      const [count, summaryValue, decimals] = await client.readContract({
        address: this.registryAddresses.reputation,
        abi: REPUTATION_ABI,
        functionName: "getSummary",
        args: [agentId, [], "", ""], // All clients, no tag filter
      }) as [bigint, bigint, number];

      const avgScore = decimals > 0
        ? Number(summaryValue) / Math.pow(10, decimals)
        : Number(summaryValue);

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
      registrations: [{
        agentId: params.agentId,
        agentRegistry: `eip155:${chainId}:${this.registryAddresses.identity}`,
      }],
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
