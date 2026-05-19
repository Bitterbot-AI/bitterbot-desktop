#!/usr/bin/env -S node --import=tsx
/**
 * runners/run-single-game.ts — play one ARC-AGI-3 game via the agent.
 *
 * Usage:
 *   node --import=tsx runners/run-single-game.ts --game GAME_ID \
 *        [--max-turns 30] [--card CARD_ID] [--output FILE.jsonl]
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { playGame } from "../src/agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      game: { type: "string", default: "" },
      "max-turns": { type: "string", default: "30" },
      card: { type: "string", default: "" },
      output: { type: "string", default: "" },
      model: { type: "string", default: "" },
    },
    strict: false,
  });
  if (!values.game) {
    console.error("Missing --game GAME_ID");
    process.exit(2);
  }
  const benchmarkRoot = path.resolve(__dirname, "..");
  const eventLogPath = values.output
    ? path.resolve(values.output)
    : path.join(benchmarkRoot, "results", `single-${Date.now()}.jsonl`);
  // Start every run with a fresh log so prior failed/aborted runs don't
  // pollute the JSONL with interleaved turn numbers.
  if (existsSync(eventLogPath)) rmSync(eventLogPath);
  const result = await playGame({
    gameId: values.game,
    cardId: values.card || undefined,
    cwd: benchmarkRoot,
    maxTurns: parseInt(values["max-turns"]!, 10),
    model: values.model || undefined,
    eventLogPath,
  });
  console.log("--- summary ---");
  console.log(JSON.stringify(result, null, 2));
  console.log(`(event log at ${eventLogPath})`);
}

main().catch((err) => {
  console.error("run-single-game failed:", err);
  process.exit(1);
});
