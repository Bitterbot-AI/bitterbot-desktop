import type { SkillEntry } from "../../agents/skills/types.js";
import type { A2aConfig } from "../../config/types.a2a.js";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { A2aAgentCard, A2aSkill } from "./types.js";
import { getLocalWalletCapability } from "../../infra/wallet-discovery.js";

const A2A_PROTOCOL_VERSION = "a2a/1.0.0";
const AGENT_CARD_VERSION = "1.0.0";

/**
 * Build the A2A Agent Card for this Bitterbot node.
 *
 * The card is served at `/.well-known/agent.json` and advertises
 * the node's capabilities, skills, and authentication requirements.
 */
export function buildAgentCard(params: {
  config: BitterbotConfig;
  skills: SkillEntry[];
  gatewayUrl: string;
  /** Per-skill prices from the marketplace economics manager */
  skillPrices?: Map<string, number>;
}): A2aAgentCard {
  const { config, skills, gatewayUrl } = params;
  const a2a: A2aConfig = config.a2a ?? {};

  const baseUrl = a2a.url ?? gatewayUrl;
  const a2aEndpoint = `${baseUrl.replace(/\/+$/, "")}/a2a`;

  const card: A2aAgentCard = {
    name: a2a.name ?? config.ui?.assistant?.name ?? "Bitterbot Node",
    description:
      a2a.description ??
      "AI agent with persistent memory, skill execution, and multi-channel messaging",
    url: a2aEndpoint,
    version: AGENT_CARD_VERSION,
    protocol: A2A_PROTOCOL_VERSION,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills: mapSkills(skills, a2a),
  };

  // Authentication
  const authType = a2a.authentication?.type ?? "bearer";
  if (authType !== "none") {
    card.authentication = { schemes: [authType] };
  }

  // Extensions
  const extensions: Record<string, unknown> = {};

  // x402 payment extension. Prefer the live wallet address advertised to the
  // mesh (resolved once the gateway initializes the CDP wallet) so the card
  // exposes the real receiving address even when it isn't hardcoded in config.
  const paymentAddress = a2a.payment?.x402?.address ?? getLocalWalletCapability()?.address;
  if (a2a.payment?.enabled && paymentAddress) {
    extensions["x402-payment"] = {
      chain: config.tools?.wallet?.network ?? "base",
      token: "USDC",
      address: paymentAddress,
      minPayment: String(a2a.payment.x402?.minPayment ?? 0.01),
      pricing: "per-task",
    };
  }

  // P2P mesh extension
  if (config.p2p?.enabled) {
    extensions["bitterbot-mesh"] = {
      meshCapabilities: ["skill-delegation", "knowledge-crystals"],
    };
  }

  // PLAN-20: advertise executable-tier skill capability so peer agents
  // can negotiate over deterministic skill execution. Lists the
  // executable-tier skill ids served by this node.
  const executableSkills = skills
    .filter((s) => s.metadata?.tier === "executable")
    .map((s) => s.metadata?.skillKey ?? s.skill.name);
  if (executableSkills.length > 0) {
    extensions["bitterbot-executable-skills"] = {
      version: "plan20/1.0",
      tier: "executable",
      skills: executableSkills,
      interceptorContract: "should_activate + intervene",
      meshExecution: "gated-on-issue-21",
    };
  }

  if (Object.keys(extensions).length > 0) {
    card.extensions = extensions;
  }

  // Add per-skill pricing from marketplace if available
  if (params.skillPrices && a2a.marketplace?.enabled !== false) {
    for (const skill of card.skills) {
      const price = params.skillPrices.get(skill.id);
      if (price !== undefined && price > 0) {
        (skill as A2aSkill & { extensions?: Record<string, unknown> }).extensions = {
          ...(skill as A2aSkill & { extensions?: Record<string, unknown> }).extensions,
          pricing: {
            priceUsdc: price,
            chain: "base",
            token: "USDC",
          },
        };
      }
    }
  }

  // PLAN-8 Phase 5 / ERC-8004 mainnet (2026-01-29). When the operator has
  // registered an onchain identity for this agent, advertise the tokenId
  // + registry contract so callers can look up reputation/feedback history
  // on the standard Identity + Reputation Registries.
  if (a2a.erc8004?.enabled && a2a.erc8004.tokenId) {
    const chain = a2a.erc8004.chain ?? "base";
    const registry = a2a.erc8004.registry ?? CANONICAL_ERC8004_IDENTITY[chain];
    extensions["erc8004"] = {
      tokenId: a2a.erc8004.tokenId,
      registry,
      chain,
    };
    if (!card.extensions) {
      card.extensions = extensions;
    }
  }

  return card;
}

/**
 * Canonical ERC-8004 Identity Registry addresses on each supported chain.
 * Source: src/services/erc8004-identity.ts (single source of truth).
 * Mainnet went live 2026-01-29.
 */
const CANONICAL_ERC8004_IDENTITY: Record<"base" | "base-sepolia", string> = {
  base: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "base-sepolia": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

function mapSkills(skills: SkillEntry[], a2a: A2aConfig): A2aSkill[] {
  const expose = a2a.skills?.expose ?? "all";
  if (expose === "none") {
    return [];
  }

  const allowlist = a2a.skills?.allowlist;

  const mapped: A2aSkill[] = [];
  for (const entry of skills) {
    const name = entry.skill.name;
    if (allowlist && !allowlist.includes(name)) {
      continue;
    }

    const tags: string[] = [];
    if (entry.metadata?.primaryEnv) {
      tags.push(entry.metadata.primaryEnv);
    }
    // PLAN-20: tag executable-tier skills so peers querying the agent
    // card can filter on deterministic behavior. Executable-tier skills
    // ship with pre-action interceptors whose activation/outcome
    // statistics are signed and verifiable.
    if (entry.metadata?.tier === "executable") {
      tags.push("executable");
    } else if (entry.metadata?.tier === "data") {
      tags.push("data");
    }

    const skill: A2aSkill & { extensions?: Record<string, unknown> } = {
      id: entry.metadata?.skillKey ?? slugify(name),
      name,
      description: entry.skill.description ?? name,
      tags: tags.length > 0 ? tags : undefined,
    };
    if (entry.metadata?.tier === "executable" && entry.metadata.interceptors) {
      skill.extensions = {
        "bitterbot-interceptors": {
          tier: "executable",
          interceptorIds: entry.metadata.interceptors.map((i) => i.id),
          builtin: entry.metadata.interceptors.every((i) => i.builtin === true),
        },
      };
    }
    mapped.push(skill);
  }

  return mapped;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
