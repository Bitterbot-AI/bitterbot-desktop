#!/usr/bin/env -S node --import=tsx
/**
 * actions/list-games.ts
 *
 * Lists all games visible to the configured `ARC_API_KEY` (or 3 of
 * the public 25 when anonymous), caches the result to games.json,
 * prints a human-readable summary.
 *
 * Usage:
 *   node --import=tsx benchmarks/arc-agi-3/actions/list-games.ts
 */

import { ArcClient } from "../src/arc-client.js";
import { cacheGames } from "../src/state.js";

async function main(): Promise<void> {
  const client = new ArcClient();
  if (!client.hasApiKey()) {
    console.error("⚠  ARC_API_KEY not set — using anonymous access (3 public games visible).");
  }
  const games = await client.listGames();
  cacheGames(games);
  console.log(`Discovered ${games.length} game(s):`);
  for (const g of games) {
    console.log(`  ${g.game_id}\t${g.title}`);
  }
}

main().catch((err) => {
  console.error("list-games failed:", err);
  process.exit(1);
});
