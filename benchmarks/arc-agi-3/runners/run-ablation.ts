#!/usr/bin/env -S node --import=tsx
/**
 * runners/run-ablation.ts — drive the multi-game evaluation loop.
 *
 * For PLAN-19 Phase 5 this just runs one cell at a time (default
 * `full` config). The 5-cell matrix (baseline/+memory/+hypothesis/
 * +curiosity/full) requires per-cell MCP tool gating, which is
 * Phase 6c follow-up.
 *
 * Usage:
 *   node --import=tsx runners/run-ablation.ts \
 *        --cell full \
 *        --games "ls20-abc wm-def ..." \
 *        --output-dir results/ablation-X/full \
 *        [--max-turns 30] [--card CARD_ID]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runGames } from "../src/run-games.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cell: { type: "string", default: "full" },
      games: { type: "string", default: "" },
      "output-dir": { type: "string", default: "" },
      "max-turns": { type: "string", default: "30" },
      card: { type: "string", default: "" },
      model: { type: "string", default: "" },
    },
    strict: false,
  });
  const gameIds = (values.games ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (gameIds.length === 0) {
    console.error("Missing --games '<id> <id> ...'");
    process.exit(2);
  }
  const benchmarkRoot = path.resolve(__dirname, "..");
  const outputDir = values["output-dir"]
    ? path.resolve(values["output-dir"])
    : path.join(benchmarkRoot, "results", `ablation-${values.cell}-${Date.now()}`);

  const summary = await runGames({
    gameIds,
    cwd: benchmarkRoot,
    cardId: values.card || undefined,
    outputDir,
    maxTurns: parseInt(values["max-turns"]!, 10),
    model: values.model || undefined,
  });
  console.log("--- ablation summary ---");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`(per-game results + events.jsonl at ${outputDir})`);
}

main().catch((err) => {
  console.error("run-ablation failed:", err);
  process.exit(1);
});
