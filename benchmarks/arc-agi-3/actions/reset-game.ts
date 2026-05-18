#!/usr/bin/env -S node --import=tsx
/**
 * actions/reset-game.ts
 *
 * Resets the current game session. Default: level reset (existing guid).
 * Use --full to fully restart the game (new session, new guid).
 *
 * Usage:
 *   node --import=tsx actions/reset-game.ts --game GAME_ID [--full]
 */

import { parseArgs } from "node:util";
import { ArcClient } from "../src/arc-client.js";
import {
  getCurrentSession,
  persistFrameResponse,
  readConfig,
  upsertSession,
} from "../src/state.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      game: { type: "string", default: "" },
      full: { type: "boolean", default: false },
    },
    strict: false,
  });
  if (!values.game) {
    console.error("Missing --game GAME_ID");
    process.exit(2);
  }
  const cfg = readConfig();
  const cardId = cfg.currentCardId;
  if (!cardId) {
    console.error("No card_id — open one first via open-scorecard.ts");
    process.exit(2);
  }
  const session = getCurrentSession(values.game);
  const client = new ArcClient();
  const guid = values.full ? null : (session?.guid ?? null);
  const frame = await client.reset({ gameId: values.game, cardId, guid });
  const { index } = persistFrameResponse({ gameId: values.game, response: frame });
  upsertSession({
    game_id: values.game,
    guid: frame.guid,
    started_at: values.full
      ? new Date().toISOString()
      : (session?.started_at ?? new Date().toISOString()),
    card_id: cardId,
    last_state: frame.state,
    levels_completed: frame.levels_completed,
    actions_submitted: values.full ? 0 : (session?.actions_submitted ?? 0),
  });
  console.log(
    JSON.stringify({
      mode: values.full ? "full" : "level",
      guid: frame.guid,
      state: frame.state,
      levels_completed: frame.levels_completed,
      available_actions: frame.available_actions,
      frame_index: index,
    }),
  );
}

main().catch((err) => {
  console.error("reset-game failed:", err);
  process.exit(1);
});
