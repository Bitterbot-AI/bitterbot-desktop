#!/usr/bin/env -S node --import=tsx
/**
 * actions/start-game.ts
 *
 * RESETs the named game to start a fresh session under the current
 * scorecard, persists the first frame, prints a summary.
 *
 * Usage:
 *   node --import=tsx actions/start-game.ts --game GAME_ID [--card CARD_ID]
 */

import { parseArgs } from "node:util";
import { ArcClient } from "../src/arc-client.js";
import { persistFrameResponse, readConfig, upsertSession } from "../src/state.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      game: { type: "string", default: "" },
      card: { type: "string", default: "" },
    },
    strict: false,
  });
  if (!values.game) {
    console.error("Missing --game GAME_ID");
    process.exit(2);
  }
  const cfg = readConfig();
  const cardId = values.card || cfg.currentCardId;
  if (!cardId) {
    console.error("No card_id — open one first via open-scorecard.ts");
    process.exit(2);
  }
  const client = new ArcClient();
  const frame = await client.reset({ gameId: values.game, cardId, guid: null });
  const { index } = persistFrameResponse({ gameId: values.game, response: frame });
  upsertSession({
    game_id: values.game,
    guid: frame.guid,
    started_at: new Date().toISOString(),
    card_id: cardId,
    last_state: frame.state,
    levels_completed: frame.levels_completed,
    actions_submitted: 0,
  });
  console.log(`Started game ${values.game}`);
  console.log(`  guid: ${frame.guid}`);
  console.log(`  state: ${frame.state}`);
  console.log(`  win_levels: ${frame.win_levels}`);
  console.log(`  available_actions: [${frame.available_actions.join(", ")}]`);
  console.log(`  frame_0000 persisted (index=${index})`);
}

main().catch((err) => {
  console.error("start-game failed:", err);
  process.exit(1);
});
