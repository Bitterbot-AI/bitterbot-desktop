import { describe, expect, it } from "vitest";
import {
  AgentIdentityService,
  buildReputationFeedback,
  type ReceiptReader,
} from "./erc8004-identity.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO32 = "0x" + "0".repeat(64);
const IDENTITY_SEPOLIA = "0x8004A818BFB912233c491871b3d84c89A494BD9e".toLowerCase();

function tokenIdTopic(id: number): string {
  return "0x" + id.toString(16).padStart(64, "0");
}

function mockWallet(txHash: string) {
  return { writeContract: async () => txHash };
}

describe("ERC-8004 identity activation (PLAN-47 Phase 3)", () => {
  it("parses the minted agentId from the registration receipt", async () => {
    const svc = new AgentIdentityService({
      network: "base-sepolia",
      agentCardUrl: "https://x/card",
    });
    const publicClient: ReceiptReader = {
      getTransactionReceipt: async () => ({
        logs: [
          // unrelated log from another contract
          {
            address: "0x00000000000000000000000000000000000000ff",
            topics: [TRANSFER_TOPIC, ZERO32, ZERO32, tokenIdTopic(1)],
          },
          // the mint from the identity registry: from == 0x0, tokenId == 42
          {
            address: IDENTITY_SEPOLIA,
            topics: [TRANSFER_TOPIC, ZERO32, "0x" + "11".repeat(32), tokenIdTopic(42)],
          },
        ],
      }),
    };
    const { agentId } = await svc.register(mockWallet("0xabc"), { publicClient });
    expect(agentId).toBe("42");
    expect(svc.getAgentId()).toBe(42n);
  });

  it("returns 'pending' when no public client is supplied (unchanged legacy path)", async () => {
    const svc = new AgentIdentityService({
      network: "base-sepolia",
      agentCardUrl: "https://x/card",
    });
    const { agentId, txHash } = await svc.register(mockWallet("0xdef"));
    expect(agentId).toBe("pending");
    expect(txHash).toBe("0xdef");
  });

  it("returns 'pending' when the receipt has no mint from the registry", async () => {
    const svc = new AgentIdentityService({
      network: "base-sepolia",
      agentCardUrl: "https://x/card",
    });
    const publicClient: ReceiptReader = {
      getTransactionReceipt: async () => ({
        logs: [
          // a transfer, but from a non-zero address (not a mint)
          {
            address: IDENTITY_SEPOLIA,
            topics: [
              TRANSFER_TOPIC,
              "0x" + "22".repeat(32),
              "0x" + "11".repeat(32),
              tokenIdTopic(7),
            ],
          },
        ],
      }),
    };
    const { agentId } = await svc.register(mockWallet("0x1"), { publicClient });
    expect(agentId).toBe("pending");
  });

  describe("buildReputationFeedback bridge", () => {
    it("maps a success rate in [0,1] onto the registry [-1,1] scale", () => {
      expect(buildReputationFeedback({ successRate: 1, sampleSize: 10 })?.value).toBe(1);
      expect(buildReputationFeedback({ successRate: 0, sampleSize: 10 })?.value).toBe(-1);
      expect(buildReputationFeedback({ successRate: 0.5, sampleSize: 10 })?.value).toBe(0);
    });

    it("refuses to project a score from thin data (conservative)", () => {
      expect(buildReputationFeedback({ successRate: 1, sampleSize: 2 })).toBeNull();
      expect(
        buildReputationFeedback({ successRate: 1, sampleSize: 2 }, { minSample: 2 }),
      ).not.toBeNull();
    });

    it("tags the feedback with source and sample size", () => {
      const fb = buildReputationFeedback({ successRate: 0.8, sampleSize: 20 }, { tag1: "forage" });
      expect(fb?.tag1).toBe("forage");
      expect(fb?.tag2).toBe("n=20");
    });
  });
});
