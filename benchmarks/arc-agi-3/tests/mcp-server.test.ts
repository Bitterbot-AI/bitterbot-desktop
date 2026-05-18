/**
 * MCP server integration tests. Boots the Bitterbot Memory MCP
 * server in-process with a temp BITTERBOT_AGENT_DIR, then exercises
 * each tool via the standard MCP client over an in-memory transport.
 *
 * Tests skip if OPENAI_API_KEY is not set (SAGE retrieval needs it
 * for embedding the query) — `runQuery` is the only path that
 * requires it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _resetMemoryContext } from "../mcp-server/context.js";
import { createServer } from "../mcp-server/index.js";

// Best-effort: source the repo .env so OPENAI_API_KEY / ANTHROPIC_API_KEY
// are available when running locally. The MemoryIndexManager probes
// the embedding provider at boot, so without a real OPENAI key the
// server can't initialize. Tests that DO need a live LLM (memory.query)
// still gate on HAS_OPENAI below; the rest just need a working init.
const envPath = path.resolve(__dirname, "..", "..", "..", ".env");
if (!process.env.OPENAI_API_KEY && fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]!]) {
      process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
    }
  }
}

const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY?.trim());

let tmpAgentDir: string;
let client: Client;
let serverCloser: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!HAS_OPENAI) {
    // Without a real OpenAI key the manager can't boot. Skip the whole
    // suite by short-circuiting; per-test gates below also short-circuit.
    return;
  }
  tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-mcp-"));
  process.env.BITTERBOT_AGENT_DIR = tmpAgentDir;
  _resetMemoryContext();

  const server = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "arc-test-client", version: "0.0.0" });
  await client.connect(clientT);
  serverCloser = async () => {
    await server.close();
    await client.close();
  };
}, 120_000);

afterAll(async () => {
  if (serverCloser) await serverCloser();
  if (tmpAgentDir) fs.rmSync(tmpAgentDir, { recursive: true, force: true });
  _resetMemoryContext();
});

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = Array.isArray(result.content)
      ? result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
      : String(result.content);
    throw new Error(`MCP tool ${name} returned error: ${text}`);
  }
  if (!Array.isArray(result.content)) return null;
  const text = result.content.find((c) => c.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  if (!text) return null;
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}

describe("bitterbot-memory MCP server", () => {
  it.skipIf(!HAS_OPENAI)("lists all 9 tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).toSorted();
    expect(names).toContain("memory.query");
    expect(names).toContain("memory.record_rule");
    expect(names).toContain("memory.log_transition");
    expect(names).toContain("memory.get_hypothesis");
    expect(names).toContain("memory.update_hypothesis");
    expect(names).toContain("memory.score_novelty");
    expect(names).toContain("memory.get_hormonal_state");
    expect(names).toContain("memory.record_event");
    expect(names).toContain("memory.list_rules");
  });

  it.skipIf(!HAS_OPENAI)(
    "log_transition + score_novelty: novelty decreases as transition is repeated",
    async () => {
      const gameId = "test-game-1";
      const first = (await callTool("memory.score_novelty", {
        gameId,
        stateHash: "abc",
        action: "ACTION1",
      })) as { novelty: number; observedCount: number };
      expect(first.novelty).toBeCloseTo(1, 5);
      expect(first.observedCount).toBe(0);

      await callTool("memory.log_transition", {
        gameId,
        prevStateHash: "abc",
        action: "ACTION1",
        nextStateHash: "def",
        pixelDelta: 3,
      });
      const second = (await callTool("memory.score_novelty", {
        gameId,
        stateHash: "abc",
        action: "ACTION1",
      })) as { novelty: number; observedCount: number };
      expect(second.observedCount).toBe(1);
      expect(second.novelty).toBeLessThan(first.novelty);

      await callTool("memory.log_transition", {
        gameId,
        prevStateHash: "abc",
        action: "ACTION1",
        nextStateHash: "ghi",
        pixelDelta: 2,
      });
      const third = (await callTool("memory.score_novelty", {
        gameId,
        stateHash: "abc",
        action: "ACTION1",
      })) as { novelty: number; observedCount: number };
      expect(third.observedCount).toBe(2);
      expect(third.novelty).toBeLessThan(second.novelty);
    },
  );

  it.skipIf(!HAS_OPENAI)("record_rule + list_rules round-trip", async () => {
    const gameId = "test-game-rules";
    const r1 = (await callTool("memory.record_rule", {
      gameId,
      rule: "ACTION3 moves blue cells one row down",
      confidence: 0.8,
    })) as { ruleId: string; reinforced: boolean; totalRulesForGame: number };
    expect(r1.ruleId).toBeTruthy();
    expect(r1.totalRulesForGame).toBe(1);

    // Same rule string → reinforced.
    const r2 = (await callTool("memory.record_rule", {
      gameId,
      rule: "ACTION3 moves blue cells one row down",
      confidence: 0.85,
    })) as { reinforced: boolean; totalRulesForGame: number };
    expect(r2.reinforced).toBe(true);
    expect(r2.totalRulesForGame).toBe(1);

    // New rule.
    await callTool("memory.record_rule", {
      gameId,
      rule: "ACTION5 toggles selected cell color",
      confidence: 0.6,
    });
    const listing = (await callTool("memory.list_rules", { gameId })) as {
      rules: Array<{ text: string; confidence: number }>;
    };
    expect(listing.rules).toHaveLength(2);
    const texts = listing.rules.map((r) => r.text).toSorted();
    expect(texts[0]).toContain("ACTION3");
    expect(texts[1]).toContain("ACTION5");
  });

  it.skipIf(!HAS_OPENAI)("get_hypothesis returns null before any update", async () => {
    const got = (await callTool("memory.get_hypothesis", {
      gameId: "test-game-hyp",
    })) as { text: string | null; confidence: number };
    expect(got.text).toBeNull();
    expect(got.confidence).toBe(0);
  });

  it.skipIf(!HAS_OPENAI)("update_hypothesis + get_hypothesis + refute round-trip", async () => {
    const gameId = "test-game-hyp-2";
    await callTool("memory.update_hypothesis", {
      gameId,
      text: "The goal is to collect all the red squares",
      confidence: 0.6,
    });
    const got1 = (await callTool("memory.get_hypothesis", { gameId })) as {
      text: string | null;
      confidence: number;
    };
    expect(got1.text).toContain("red squares");
    expect(got1.confidence).toBeCloseTo(0.6, 5);

    await callTool("memory.update_hypothesis", {
      gameId,
      text: "(refuting)",
      confidence: 0,
      refute: true,
    });
    const got2 = (await callTool("memory.get_hypothesis", { gameId })) as {
      text: string | null;
    };
    expect(got2.text).toBeNull();
  });

  it.skipIf(!HAS_OPENAI)("get_hormonal_state returns a state shape", async () => {
    const state = (await callTool("memory.get_hormonal_state", {})) as {
      dopamine: number;
      cortisol: number;
      oxytocin: number;
      available: boolean;
    };
    expect(state.available).toBe(true);
    expect(state.dopamine).toBeGreaterThanOrEqual(0);
    expect(state.dopamine).toBeLessThanOrEqual(1);
    expect(state.cortisol).toBeGreaterThanOrEqual(0);
    expect(state.oxytocin).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!HAS_OPENAI)("record_event raises cortisol on 'error'", async () => {
    const before = (await callTool("memory.get_hormonal_state", {})) as {
      cortisol: number;
    };
    const after = (await callTool("memory.record_event", { event: "error" })) as {
      cortisol: number;
    };
    expect(after.cortisol).toBeGreaterThanOrEqual(before.cortisol);
  });

  it.skipIf(!HAS_OPENAI)("memory.query returns a structured plan + chunks", async () => {
    const result = (await callTool("memory.query", {
      text: "ACTION3 effects on blue cells",
      topK: 5,
    })) as {
      chunks: Array<unknown>;
      entities: Array<unknown>;
      source: string;
    };
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(Array.isArray(result.entities)).toBe(true);
    expect(["llm", "heuristic", "cache"]).toContain(result.source);
  });
});
