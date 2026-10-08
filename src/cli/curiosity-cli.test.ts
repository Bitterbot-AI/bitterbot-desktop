import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
vi.mock("../gateway/call.js", () => ({
  callGateway: async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
    calls.push({ method, params });
    if (method === "curiosity.status") {
      return {
        enabled: true,
        disabledBy: null,
        paused: false,
        searchConfigured: true,
        intervalMinutes: 240,
        nextRunAt: null,
        today: { attempted: 2, budget: 10 },
        openQuestions: 1,
        totals: { learned: 3, used: 2, roi: 2 / 3, costUsd: 0.0234 },
        last30d: { learned: 3, used: 2, roi: 2 / 3, costUsd: 0.0234 },
      };
    }
    if (method === "curiosity.list") {
      return {
        wondering: [
          {
            id: "abcdef12-0000",
            description: "How do relays cap reservations?",
            attempts: 1,
            lastOutcome: "containment_rejected",
            source: "working_memory",
            heldPhrase: "relay caps per peer",
          },
        ],
        learned: [
          {
            id: "f1",
            question: "What does ProbeLab measure?",
            answer: "Network size and DHT health.",
            confidence: 0.75,
            sources: [{ url: "https://probelab.io/x" }],
            createdAt: 1_800_000_000_000,
            usedCount: 1,
            costUsd: 0.0078,
            verified: true,
            current: true,
          },
        ],
        closed: [
          { id: "c1", description: "when is the sprint retro", outcome: "not_web_answerable" },
        ],
      };
    }
    if (method === "curiosity.ask") return { id: "11111111-2222", queued: true };
    if (method === "curiosity.dismiss") return { dismissed: true };
    if (method === "curiosity.runNow") return { started: true };
    return { ok: true };
  },
}));

const logs: string[] = [];
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (s: string) => logs.push(s),
    error: (s: string) => logs.push(`ERR ${s}`),
    exit: () => {},
  },
}));

async function run(argv: string[]): Promise<void> {
  const { registerCuriosityCli } = await import("./curiosity-cli.js");
  const program = new Command();
  program.exitOverride();
  registerCuriosityCli(program);
  await program.parseAsync(["node", "bitterbot", "curiosity", ...argv]);
}

afterEach(() => {
  calls.length = 0;
  logs.length = 0;
});

describe("bitterbot curiosity", () => {
  it("status prints the state, budget and utility in words", async () => {
    await run(["status"]);
    const out = logs.join("\n");
    expect(out).toContain("exploring");
    expect(out).toContain("2 of 10 questions");
    expect(out).toContain("learned: 3, came in useful: 2 (67%)");
  });

  it("list shows questions with why they are held, and findings with sources", async () => {
    await run(["list"]);
    const out = logs.join("\n");
    expect(out).toContain("abcdef12  How do relays cap reservations?");
    expect(out).toContain("refused to send: “relay caps per peer”");
    expect(out).toContain("What does ProbeLab measure?");
    expect(out).toContain("https://probelab.io/x");
    expect(out).toContain("not_web_answerable");
  });

  it("ask joins the words into one question; dismiss resolves an id prefix; run starts a pass", async () => {
    await run(["ask", "How", "big", "is", "the", "IPFS", "DHT?"]);
    expect(calls.at(-1)).toEqual({
      method: "curiosity.ask",
      params: { question: "How big is the IPFS DHT?" },
    });
    await run(["dismiss", "abcdef12"]);
    expect(calls.at(-1)).toEqual({ method: "curiosity.dismiss", params: { id: "abcdef12-0000" } });
    await run(["run"]);
    expect(calls.at(-1)?.method).toBe("curiosity.runNow");
    expect(logs.at(-1)).toContain("started");
    await run(["pause"]);
    expect(calls.at(-1)?.method).toBe("curiosity.pause");
  });

  it("--json prints the raw payload", async () => {
    await run(["status", "--json"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ enabled: true, openQuestions: 1 });
  });
});
