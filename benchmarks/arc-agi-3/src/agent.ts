/**
 * ARC-AGI-3 agent driver.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` to drive a Claude
 * Code session that plays one ARC-AGI-3 game. Claude reads `CLAUDE.md`,
 * calls the action scripts in `actions/` via bash, and calls the
 * bitterbot-memory MCP tools (registered programmatically via the SDK's
 * mcpServers option) for persistent biological memory.
 *
 * The driver emits one structured `ARC {...}` JSON line per Claude
 * Code message for live monitoring (matches `LME {...}` pattern from
 * benchmarks/longmemeval).
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArcClient } from "./arc-client.js";
import { getCurrentSession, readGameMeta, readConfig } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PlayGameOptions {
  gameId: string;
  /** Defaults to config.json's currentCardId. */
  cardId?: string;
  /** Defaults to the benchmark package root. */
  cwd?: string;
  /** Max agentic turns (Claude Code internal). Default 30. */
  maxTurns?: number;
  /** Where to append `ARC {...}` JSON event lines. Default stdout. */
  eventLogPath?: string;
  /** Optional model override. */
  model?: string;
  /** Optional abort controller for early cancel. */
  abortController?: AbortController;
}

export interface PlayGameResult {
  gameId: string;
  turns: number;
  actionsSubmitted: number;
  levelsCompleted: number;
  state: string;
  totalTokens: number;
  totalCostUsd: number;
  errorMessage?: string;
  durationMs: number;
}

function emit(event: Record<string, unknown>, eventLogPath: string | undefined): void {
  const line = `ARC ${JSON.stringify(event)}`;
  if (eventLogPath) {
    appendFileSync(eventLogPath, line + "\n", "utf8");
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

/**
 * Play a single ARC-AGI-3 game end-to-end via Claude Code SDK.
 */
export async function playGame(opts: PlayGameOptions): Promise<PlayGameResult> {
  const started = Date.now();
  const cwd = opts.cwd ?? path.resolve(__dirname, "..");
  const eventLogPath = opts.eventLogPath;
  if (eventLogPath) {
    mkdirSync(path.dirname(eventLogPath), { recursive: true });
  }

  const cfg = readConfig(cwd);
  const cardId = opts.cardId ?? cfg.currentCardId;
  if (!cardId) {
    throw new Error(
      `No card_id available — open a scorecard before playing (actions/open-scorecard.ts).`,
    );
  }
  // Confirm the game is reachable / API key works before burning agent turns.
  const probe = new ArcClient();
  if (!probe.hasApiKey()) {
    throw new Error("ARC_API_KEY is not configured in the environment.");
  }

  const initialPrompt = [
    `Play the ARC-AGI-3 game "${opts.gameId}".`,
    `Card ID: ${cardId}.`,
    `Read CLAUDE.md FIRST to learn how to play and how to use the bitterbot-memory MCP tools.`,
    `Goal: complete as many levels as possible with as FEW actions as possible — RHAE is quadratic in action efficiency.`,
    `Start by calling memory.list_rules({gameId: "${opts.gameId}"}) to see if you've played this game before.`,
    `Then call actions/start-game.ts --game ${opts.gameId} to begin the session.`,
  ].join("\n");

  emit(
    {
      kind: "start",
      gameId: opts.gameId,
      cardId,
      cwd,
      maxTurns: opts.maxTurns ?? 30,
    },
    eventLogPath,
  );

  let turns = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let errorMessage: string | undefined;

  // Resolve the MCP server entry point relative to the repo root so the
  // Claude Code SDK can launch it as a child process via stdio. We avoid
  // the .claude/mcp.json filesystem config because that directory is in
  // the repo-wide .gitignore — registering the server programmatically
  // keeps the config in source-controlled code.
  const repoRoot = path.resolve(cwd, "..", "..");
  const mcpEntry = path.join(cwd, "mcp-server", "index.ts");

  try {
    const iter = query({
      prompt: initialPrompt,
      options: {
        cwd,
        maxTurns: opts.maxTurns ?? 30,
        model: opts.model,
        abortController: opts.abortController,
        mcpServers: [
          {
            "bitterbot-memory": {
              type: "stdio",
              command: "node",
              args: ["--import=tsx", mcpEntry],
              env: {
                BITTERBOT_AGENT_DIR:
                  process.env.BITTERBOT_AGENT_DIR ??
                  path.join(process.env.HOME ?? repoRoot, ".bitterbot/agents/arc-agi-3"),
                OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
              },
            },
          },
        ],
      },
    });
    for await (const message of iter as AsyncIterable<SDKMessage>) {
      turns += 1;
      const summary = summarizeMessage(message);
      if (summary.totalTokens) totalTokens += summary.totalTokens;
      if (summary.costUsd) totalCostUsd += summary.costUsd;
      emit({ kind: "msg", turn: turns, ...summary }, eventLogPath);
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    emit({ kind: "error", message: errorMessage }, eventLogPath);
  }

  const session = getCurrentSession(opts.gameId, cwd);
  const meta = readGameMeta(opts.gameId, cwd);
  const result: PlayGameResult = {
    gameId: opts.gameId,
    turns,
    actionsSubmitted: session?.actions_submitted ?? 0,
    levelsCompleted: session?.levels_completed ?? meta.levels_completed ?? 0,
    state: session?.last_state ?? "UNKNOWN",
    totalTokens,
    totalCostUsd,
    errorMessage,
    durationMs: Date.now() - started,
  };
  emit({ kind: "end", ...result }, eventLogPath);
  return result;
}

interface MessageSummary {
  type: string;
  toolUses?: string[];
  textPreview?: string;
  totalTokens?: number;
  costUsd?: number;
  isError?: boolean;
}

function summarizeMessage(message: SDKMessage): MessageSummary {
  switch (message.type) {
    case "assistant": {
      const content = message.message?.content ?? [];
      const toolUses: string[] = [];
      const textParts: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            toolUses.push(block.name);
          } else if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          }
        }
      }
      const usage = message.message?.usage;
      const totalTokens =
        usage && typeof usage === "object"
          ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
          : 0;
      return {
        type: "assistant",
        toolUses: toolUses.length > 0 ? toolUses : undefined,
        textPreview: textParts.join(" ").slice(0, 200) || undefined,
        totalTokens: totalTokens || undefined,
      };
    }
    case "result": {
      const r = message as {
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const usage = r.usage;
      const totalTokens =
        usage && typeof usage === "object"
          ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
          : 0;
      return {
        type: "result",
        totalTokens: totalTokens || undefined,
        costUsd: r.total_cost_usd,
      };
    }
    default:
      return { type: message.type };
  }
}
