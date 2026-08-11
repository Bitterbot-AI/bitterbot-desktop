/**
 * PLAN-34 Phase 2b — the deterministic research-findings surfacing block.
 * Contract: renders independently of endocrine state (no hormonal deps at
 * all — the module never touches them); full prompt mode only; drains the
 * queue exactly once; kill switch is curiosity.autoResearch.enabled.
 */
import { describe, expect, it, vi } from "vitest";

let findingsQueue: Array<{ finding: string; sourceUrl: string | null }> = [];
let briefQueue: Array<{ question: string; answer: string }> = [];
let managerAvailable = true;

vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: async () =>
      managerAvailable
        ? {
            consumeResearchFindings: (limit: number) => findingsQueue.splice(0, limit),
            consumeDreamBrief: () => briefQueue.shift() ?? null,
          }
        : null,
  },
}));

async function resolve(params?: {
  promptMode?: "full" | "minimal" | "none";
  config?: Record<string, unknown>;
}) {
  const { resolveResearchFindingsBlock } = await import("./research-findings-block.js");
  return resolveResearchFindingsBlock({
    agentId: "test",
    promptMode: params?.promptMode,
    config: params?.config as never,
  });
}

describe("resolveResearchFindingsBlock", () => {
  it("renders queued findings and drains the queue (surfaced exactly once)", async () => {
    managerAvailable = true;
    findingsQueue = [
      {
        finding: 'Looked into "X" — ingested "x-skill" from docs.example.com',
        sourceUrl: "https://docs.example.com/x",
      },
    ];
    const block = await resolve({ promptMode: "full" });
    expect(block).toContain("## Research Findings");
    expect(block).toContain("while you were away");
    expect(block).toContain('Looked into "X"');
    expect(block).toContain("(source: https://docs.example.com/x)");

    // Queue drained: next resolution renders nothing.
    expect(await resolve({ promptMode: "full" })).toBeUndefined();
  });

  it("never renders for minimal or none prompt modes (subagents/cron must not consume findings)", async () => {
    managerAvailable = true;
    findingsQueue = [{ finding: "f", sourceUrl: null }];
    expect(await resolve({ promptMode: "minimal" })).toBeUndefined();
    expect(await resolve({ promptMode: "none" })).toBeUndefined();
    expect(findingsQueue).toHaveLength(1); // untouched
  });

  it("respects the curiosity.autoResearch.enabled kill switch", async () => {
    managerAvailable = true;
    findingsQueue = [{ finding: "f", sourceUrl: null }];
    const block = await resolve({
      promptMode: "full",
      config: { memory: { curiosity: { autoResearch: { enabled: false } } } },
    });
    expect(block).toBeUndefined();
    expect(findingsQueue).toHaveLength(1);
  });

  it("degrades to undefined when the manager is unavailable", async () => {
    managerAvailable = false;
    findingsQueue = [{ finding: "f", sourceUrl: null }];
    expect(await resolve({ promptMode: "full" })).toBeUndefined();
  });
});

describe("resolveResearchFindingsBlock — liveUserTurn gate (Phase 2 adv. fix)", () => {
  it("does NOT consume when liveUserTurn is false (heartbeat/subagent/cron/hook)", async () => {
    managerAvailable = true;
    findingsQueue = [{ finding: "f", sourceUrl: null }];
    const { resolveResearchFindingsBlock } = await import("./research-findings-block.js");
    const block = await resolveResearchFindingsBlock({
      agentId: "test",
      promptMode: "full",
      liveUserTurn: false,
    });
    expect(block).toBeUndefined();
    expect(findingsQueue).toHaveLength(1); // not drained
  });

  it("consumes when liveUserTurn is true", async () => {
    managerAvailable = true;
    findingsQueue = [{ finding: "looked into X", sourceUrl: null }];
    const { resolveResearchFindingsBlock } = await import("./research-findings-block.js");
    const block = await resolveResearchFindingsBlock({
      agentId: "test",
      promptMode: "full",
      liveUserTurn: true,
    });
    expect(block).toContain("looked into X");
    expect(findingsQueue).toHaveLength(0);
  });
});

/**
 * PLAN-40 Lane 3 owner gate. Briefs are cross-session synthesis of the
 * OWNER's private context; `first_party` trust is a token denylist and a
 * stranger's DM classifies first_party, so identity must decide.
 *
 * The negative case below is the one the phase adversarial pass found
 * unproven: the previous gate matched `/:dm:([^:]+)$/` against a session key
 * shape this product never mints, so it always resolved to "owner" and a
 * stranger's DM would have drained the owner's brief.
 */
describe("resolveBriefOwnerTurn — Lane 3 owner gate", () => {
  const cases: Array<{
    name: string;
    input: { liveUserTurn: boolean; senderIsOwner?: boolean; messageProvider?: string | null };
    expected: boolean;
  }> = [
    {
      name: "stranger DM on a real channel, no owner allowlist configured → refused",
      input: { liveUserTurn: true, senderIsOwner: false, messageProvider: "whatsapp" },
      expected: false,
    },
    {
      name: "stranger DM with sender identity absent entirely → refused (fails closed)",
      input: { liveUserTurn: true, messageProvider: "telegram" },
      expected: false,
    },
    {
      name: "owner-matched sender on a real channel → allowed",
      input: { liveUserTurn: true, senderIsOwner: true, messageProvider: "whatsapp" },
      expected: true,
    },
    {
      name: "Control UI / webchat turn → allowed (no third party in the transcript)",
      input: { liveUserTurn: true, senderIsOwner: false, messageProvider: "webchat" },
      expected: true,
    },
    {
      name: "local CLI drive with no channel → allowed",
      input: { liveUserTurn: true, messageProvider: null },
      expected: true,
    },
    {
      name: "not a live user turn (heartbeat/cron/subagent) → refused regardless of owner",
      input: { liveUserTurn: false, senderIsOwner: true, messageProvider: "webchat" },
      expected: false,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { resolveBriefOwnerTurn } = await import("./research-findings-block.js");
      expect(resolveBriefOwnerTurn(c.input)).toBe(c.expected);
    });
  }
});

describe("resolveResearchFindingsBlock — brief drain follows ownerTurn", () => {
  it("leaves the brief queued when ownerTurn is false", async () => {
    managerAvailable = true;
    findingsQueue = [];
    briefQueue = [{ question: "q", answer: "private cross-session sketch" }];
    const { resolveResearchFindingsBlock } = await import("./research-findings-block.js");
    const block = await resolveResearchFindingsBlock({
      agentId: "test",
      promptMode: "full",
      liveUserTurn: true,
      ownerTurn: false,
    });
    expect(block).toBeUndefined();
    expect(briefQueue).toHaveLength(1); // not drained, not leaked
  });

  it("drains the brief when ownerTurn is true", async () => {
    managerAvailable = true;
    findingsQueue = [];
    briefQueue = [{ question: "q", answer: "private cross-session sketch" }];
    const { resolveResearchFindingsBlock } = await import("./research-findings-block.js");
    const block = await resolveResearchFindingsBlock({
      agentId: "test",
      promptMode: "full",
      liveUserTurn: true,
      ownerTurn: true,
    });
    expect(block).toContain("private cross-session sketch");
    expect(briefQueue).toHaveLength(0);
  });
});
