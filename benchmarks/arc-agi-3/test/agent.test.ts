/**
 * agent.ts unit tests.
 *
 * The Claude Code SDK is mocked so these tests don't burn real API
 * credits or require a live ANTHROPIC_API_KEY.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the SDK BEFORE importing agent.ts.
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { playGame } from "../src/agent.js";
import { runGames } from "../src/run-games.js";

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "arc-agent-test-"));
  writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ apiBaseUrl: "https://three.arcprize.org", currentCardId: "card-fake-123" }),
    "utf8",
  );
  writeFileSync(
    path.join(root, "sessions.json"),
    JSON.stringify({
      "game-abc": {
        game_id: "game-abc",
        guid: "guid-1",
        started_at: new Date().toISOString(),
        card_id: "card-fake-123",
        last_state: "WIN",
        levels_completed: 2,
        actions_submitted: 17,
      },
    }),
    "utf8",
  );
  mkdirSync(path.join(root, "games", "game-abc"), { recursive: true });
  writeFileSync(
    path.join(root, "games", "game-abc", "game.json"),
    JSON.stringify({ game_id: "game-abc", levels_completed: 2, frame_count: 18 }),
    "utf8",
  );
  return root;
}

describe("playGame", () => {
  let tempRoot: string;
  const prevApiKey = process.env.ARC_API_KEY;

  beforeEach(() => {
    tempRoot = makeTempRoot();
    process.env.ARC_API_KEY = "test-key";
    process.env.ARC_AGENT_ROOT = tempRoot;
    mockQuery.mockReset();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (prevApiKey === undefined) delete process.env.ARC_API_KEY;
    else process.env.ARC_API_KEY = prevApiKey;
    delete process.env.ARC_AGENT_ROOT;
  });

  it("throws when no card id is configured", async () => {
    writeFileSync(path.join(tempRoot, "config.json"), JSON.stringify({}), "utf8");
    await expect(playGame({ gameId: "game-abc", cwd: tempRoot })).rejects.toThrow(/scorecard/);
  });

  it("throws when ARC_API_KEY is missing", async () => {
    delete process.env.ARC_API_KEY;
    await expect(playGame({ gameId: "game-abc", cwd: tempRoot })).rejects.toThrow(/ARC_API_KEY/);
  });

  it("drives the SDK and aggregates results", async () => {
    mockQuery.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Calling memory.list_rules" },
              { type: "tool_use", name: "mcp__bitterbot-memory__list_rules" },
            ],
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Action submitted" }],
            usage: { input_tokens: 200, output_tokens: 75 },
          },
        };
        yield {
          type: "result",
          total_cost_usd: 0.42,
          usage: { input_tokens: 300, output_tokens: 125 },
        };
      },
    });

    const eventLog = path.join(tempRoot, "events.jsonl");
    const result = await playGame({
      gameId: "game-abc",
      cwd: tempRoot,
      eventLogPath: eventLog,
      maxTurns: 10,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0]![0] as {
      prompt: string;
      options: { cwd: string; maxTurns: number };
    };
    expect(callArgs.prompt).toContain("game-abc");
    expect(callArgs.prompt).toContain("card-fake-123");
    expect(callArgs.options.cwd).toBe(tempRoot);
    expect(callArgs.options.maxTurns).toBe(10);

    expect(result.gameId).toBe("game-abc");
    expect(result.turns).toBe(3);
    expect(result.actionsSubmitted).toBe(17);
    expect(result.levelsCompleted).toBe(2);
    expect(result.state).toBe("WIN");
    expect(result.totalCostUsd).toBeCloseTo(0.42);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.errorMessage).toBeUndefined();

    const log = readFileSync(eventLog, "utf8").trim().split("\n");
    expect(log.length).toBeGreaterThanOrEqual(5);
    expect(log[0]).toMatch(/^ARC \{/);
    const start = JSON.parse(log[0]!.slice(4));
    expect(start.kind).toBe("start");
    expect(start.gameId).toBe("game-abc");
    const end = JSON.parse(log[log.length - 1]!.slice(4));
    expect(end.kind).toBe("end");
    expect(end.state).toBe("WIN");
  });

  it("captures SDK errors without crashing", async () => {
    mockQuery.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
        throw new Error("sdk exploded");
      },
    });
    const result = await playGame({
      gameId: "game-abc",
      cwd: tempRoot,
      eventLogPath: path.join(tempRoot, "events.jsonl"),
    });
    expect(result.errorMessage).toBe("sdk exploded");
    expect(result.turns).toBe(1);
  });
});

describe("runGames", () => {
  let tempRoot: string;
  const prevApiKey = process.env.ARC_API_KEY;

  beforeEach(() => {
    tempRoot = makeTempRoot();
    process.env.ARC_API_KEY = "test-key";
    process.env.ARC_AGENT_ROOT = tempRoot;
    mockQuery.mockReset();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (prevApiKey === undefined) delete process.env.ARC_API_KEY;
    else process.env.ARC_API_KEY = prevApiKey;
    delete process.env.ARC_AGENT_ROOT;
  });

  it("aggregates per-game and writes summary", async () => {
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          total_cost_usd: 0.1,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    });

    const outputDir = path.join(tempRoot, "out");
    const summary = await runGames({
      gameIds: ["game-abc"],
      cwd: tempRoot,
      outputDir,
      maxTurns: 5,
    });
    expect(summary.totalGames).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.errored).toBe(0);
    expect(summary.perGame[0]!.gameId).toBe("game-abc");
    expect(existsSync(path.join(outputDir, "summary.json"))).toBe(true);
    expect(existsSync(path.join(outputDir, "result_game-abc.json"))).toBe(true);
  });

  it("resumes from prior partial run by skipping cached results", async () => {
    const outputDir = path.join(tempRoot, "out");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, "result_game-abc.json"),
      JSON.stringify({
        gameId: "game-abc",
        turns: 99,
        actionsSubmitted: 5,
        levelsCompleted: 1,
        state: "WIN",
        totalTokens: 0,
        totalCostUsd: 0,
        durationMs: 0,
      }),
      "utf8",
    );

    const summary = await runGames({
      gameIds: ["game-abc"],
      cwd: tempRoot,
      outputDir,
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(summary.perGame[0]!.turns).toBe(99);
    expect(summary.completed).toBe(1);
  });
});
