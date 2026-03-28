import type { A2aConfig } from "../../config/types.a2a.js";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { SkillEntry } from "../../agents/skills/types.js";
import type { A2aAgentCard, A2aSkill } from "./types.js";

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

  // x402 payment extension
  if (a2a.payment?.enabled && a2a.payment.x402?.address) {
    extensions["x402-payment"] = {
      chain: "base",
      token: "USDC",
      address: a2a.payment.x402.address,
      minPayment: String(a2a.payment.x402.minPayment ?? 0.01),
      pricing: "per-task",
    };
  }

  // P2P mesh extension
  if (config.p2p?.enabled) {
    extensions["bitterbot-mesh"] = {
      meshCapabilities: ["skill-delegation", "knowledge-crystals"],
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
          ...((skill as A2aSkill & { extensions?: Record<string, unknown> }).extensions ?? {}),
          pricing: {
            priceUsdc: price,
            chain: "base",
            token: "USDC",
          },
        };
      }
    }
  }

  return card;
}

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

    mapped.push({
      id: entry.metadata?.skillKey ?? slugify(name),
      name,
      description: entry.skill.description ?? name,
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  return mapped;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
