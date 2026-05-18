/**
 * Multi-game evaluation driver.
 *
 * Iterates a list of game IDs, plays each one via `playGame()`, and
 * persists per-game `PlayGameResult` summaries. Survives crashes —
 * checks the per-game `result_<game>.json` file before invoking and
 * skips games that already have one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playGame, type PlayGameResult } from "./agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RunGamesOptions {
  gameIds: string[];
  /** Defaults to package root. */
  cwd?: string;
  cardId?: string;
  maxTurns?: number;
  /** Resume from prior partial runs (default true). */
  resume?: boolean;
  /** Where to write per-game result + aggregate summary. */
  outputDir?: string;
  model?: string;
  /** Optional abort controller forwarded to playGame. */
  abortController?: AbortController;
}

export interface RunGamesSummary {
  totalGames: number;
  completed: number;
  errored: number;
  totalActionsSubmitted: number;
  totalLevelsCompleted: number;
  totalCostUsd: number;
  totalDurationMs: number;
  perGame: PlayGameResult[];
}

function resultPath(outputDir: string, gameId: string): string {
  const safe = gameId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return path.join(outputDir, `result_${safe}.json`);
}

export async function runGames(opts: RunGamesOptions): Promise<RunGamesSummary> {
  const cwd = opts.cwd ?? path.resolve(__dirname, "..");
  const outputDir =
    opts.outputDir ?? path.join(cwd, "results", new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(outputDir, { recursive: true });
  const eventLogPath = path.join(outputDir, "events.jsonl");
  const summaryPath = path.join(outputDir, "summary.json");

  const perGame: PlayGameResult[] = [];
  let totalActionsSubmitted = 0;
  let totalLevelsCompleted = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let completed = 0;
  let errored = 0;

  for (const gameId of opts.gameIds) {
    if (opts.resume !== false && existsSync(resultPath(outputDir, gameId))) {
      // Skip — already done in a prior run.
      const prior = JSON.parse(
        readFileSync(resultPath(outputDir, gameId), "utf8"),
      ) as PlayGameResult;
      perGame.push(prior);
      if (prior.errorMessage) errored++;
      else completed++;
      totalActionsSubmitted += prior.actionsSubmitted;
      totalLevelsCompleted += prior.levelsCompleted;
      totalCostUsd += prior.totalCostUsd;
      totalDurationMs += prior.durationMs;
      continue;
    }

    let r: PlayGameResult;
    try {
      r = await playGame({
        gameId,
        cardId: opts.cardId,
        cwd,
        maxTurns: opts.maxTurns,
        model: opts.model,
        eventLogPath,
        abortController: opts.abortController,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      r = {
        gameId,
        turns: 0,
        actionsSubmitted: 0,
        levelsCompleted: 0,
        state: "ERROR",
        totalTokens: 0,
        totalCostUsd: 0,
        errorMessage: message,
        durationMs: 0,
      };
    }
    writeFileSync(resultPath(outputDir, gameId), JSON.stringify(r, null, 2), "utf8");
    perGame.push(r);
    if (r.errorMessage) errored++;
    else completed++;
    totalActionsSubmitted += r.actionsSubmitted;
    totalLevelsCompleted += r.levelsCompleted;
    totalCostUsd += r.totalCostUsd;
    totalDurationMs += r.durationMs;
  }

  const summary: RunGamesSummary = {
    totalGames: opts.gameIds.length,
    completed,
    errored,
    totalActionsSubmitted,
    totalLevelsCompleted,
    totalCostUsd,
    totalDurationMs,
    perGame,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  return summary;
}
