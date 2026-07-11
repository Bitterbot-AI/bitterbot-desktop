/**
 * PLAN-34 Phase 2b — the deterministic research-findings surfacing block.
 * Contract: renders independently of endocrine state (no hormonal deps at
 * all — the module never touches them); full prompt mode only; drains the
 * queue exactly once; kill switch is curiosity.autoResearch.enabled.
 */
import { describe, expect, it, vi } from "vitest";

let findingsQueue: Array<{ finding: string; sourceUrl: string | null }> = [];
let managerAvailable = true;

vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: async () =>
      managerAvailable
        ? {
            consumeResearchFindings: (limit: number) => findingsQueue.splice(0, limit),
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
