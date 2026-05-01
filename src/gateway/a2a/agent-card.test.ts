import { describe, expect, it } from "vitest";
import type { SkillEntry } from "../../agents/skills/types.js";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import { buildAgentCard } from "./agent-card.js";

function makeSkill(name: string, description = name, key = name): SkillEntry {
  return {
    skill: { name, description },
    metadata: { skillKey: key },
  } as unknown as SkillEntry;
}

function baseConfig(over: Partial<BitterbotConfig> = {}): BitterbotConfig {
  return {
    a2a: { enabled: true },
    ...over,
  } as BitterbotConfig;
}

describe("buildAgentCard", () => {
  it("builds a minimally valid card with default fields", () => {
    const card = buildAgentCard({
      config: baseConfig(),
      skills: [makeSkill("Echo")],
      gatewayUrl: "http://127.0.0.1:19001",
    });

    expect(card.name).toBe("Bitterbot Node");
    expect(card.url).toBe("http://127.0.0.1:19001/a2a");
    expect(card.protocol).toBe("a2a/1.0.0");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("Echo");
    expect(card.skills[0].name).toBe("Echo");
  });

  it("respects skills.expose=none", () => {
    const card = buildAgentCard({
      config: baseConfig({ a2a: { enabled: true, skills: { expose: "none" } } }),
      skills: [makeSkill("Echo"), makeSkill("Search")],
      gatewayUrl: "http://localhost:19001",
    });
    expect(card.skills).toEqual([]);
  });

  it("respects skills.allowlist", () => {
    const card = buildAgentCard({
      config: baseConfig({
        a2a: { enabled: true, skills: { allowlist: ["Search"] } },
      }),
      skills: [makeSkill("Echo"), makeSkill("Search")],
      gatewayUrl: "http://localhost:19001",
    });
    expect(card.skills.map((s) => s.name)).toEqual(["Search"]);
  });

  it("emits x402-payment extension when payment.enabled and address set", () => {
    const card = buildAgentCard({
      config: baseConfig({
        a2a: {
          enabled: true,
          payment: {
            enabled: true,
            x402: { address: "0x" + "ab".repeat(20), minPayment: 0.05 },
          },
        },
      }),
      skills: [],
      gatewayUrl: "http://localhost:19001",
    });
    const ext = card.extensions?.["x402-payment"] as Record<string, unknown> | undefined;
    expect(ext).toBeDefined();
    expect(ext?.chain).toBe("base");
    expect(ext?.token).toBe("USDC");
    expect(ext?.minPayment).toBe("0.05");
  });

  it("does not emit x402-payment when payment is disabled", () => {
    const card = buildAgentCard({
      config: baseConfig({
        a2a: { enabled: true, payment: { enabled: false } },
      }),
      skills: [],
      gatewayUrl: "http://localhost:19001",
    });
    expect(card.extensions?.["x402-payment"]).toBeUndefined();
  });

  it("emits erc8004 extension when configured with tokenId", () => {
    const card = buildAgentCard({
      config: baseConfig({
        a2a: {
          enabled: true,
          erc8004: { enabled: true, tokenId: "42", chain: "base" },
        },
      }),
      skills: [],
      gatewayUrl: "http://localhost:19001",
    });
    const ext = card.extensions?.["erc8004"] as Record<string, unknown> | undefined;
    expect(ext).toBeDefined();
    expect(ext?.tokenId).toBe("42");
    expect(ext?.chain).toBe("base");
    // Default to canonical mainnet registry when no explicit override
    expect(String(ext?.registry).toLowerCase()).toBe(
      "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432".toLowerCase(),
    );
  });

  it("uses canonical sepolia registry when chain=base-sepolia", () => {
    const card = buildAgentCard({
      config: baseConfig({
        a2a: {
          enabled: true,
          erc8004: { enabled: true, tokenId: "7", chain: "base-sepolia" },
        },
      }),
      skills: [],
      gatewayUrl: "http://localhost:19001",
    });
    const ext = card.extensions?.["erc8004"] as Record<string, unknown> | undefined;
    expect(String(ext?.registry).toLowerCase()).toBe(
      "0x8004A818BFB912233c491871b3d84c89A494BD9e".toLowerCase(),
    );
  });

  it("does NOT emit erc8004 extension when enabled but no tokenId", () => {
    const card = buildAgentCard({
      config: baseConfig({
        a2a: { enabled: true, erc8004: { enabled: true } },
      }),
      skills: [],
      gatewayUrl: "http://localhost:19001",
    });
    expect(card.extensions?.["erc8004"]).toBeUndefined();
  });

  it("respects an explicit a2a.url override (e.g. behind a proxy)", () => {
    const card = buildAgentCard({
      config: baseConfig({ a2a: { enabled: true, url: "https://agent.example.com" } }),
      skills: [],
      gatewayUrl: "http://127.0.0.1:19001",
    });
    expect(card.url).toBe("https://agent.example.com/a2a");
  });

  it("attaches per-skill pricing from the marketplace", () => {
    const skillPrices = new Map<string, number>([["echo", 0.1]]);
    const card = buildAgentCard({
      config: baseConfig({ a2a: { enabled: true } }),
      skills: [makeSkill("Echo", "Echo skill", "echo")],
      gatewayUrl: "http://localhost:19001",
      skillPrices,
    });
    const skill = card.skills[0] as { extensions?: { pricing?: { priceUsdc?: number } } };
    expect(skill.extensions?.pricing?.priceUsdc).toBe(0.1);
  });

  it("declares streaming + stateTransitionHistory capabilities", () => {
    const card = buildAgentCard({
      config: baseConfig(),
      skills: [],
      gatewayUrl: "http://localhost:19001",
    });
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.stateTransitionHistory).toBe(true);
    // pushNotifications is not yet implemented
    expect(card.capabilities.pushNotifications).toBe(false);
  });
});
