#!/usr/bin/env -S node --import=tsx
/**
 * actions/status.ts
 *
 * Reports the current session for a game from local state — does NOT
 * hit the API. Useful as a cheap "where am I in the game" probe.
 *
 * Usage:
 *   node --import=tsx actions/status.ts --game GAME_ID
 */

import { parseArgs } from "node:util";
import { getCurrentSession, readFrame, readGameMeta, readConfig } from "../src/state.js";

function main(): void {
  const { values } = parseArgs({
    options: { game: { type: "string", default: "" } },
    strict: false,
  });
  if (!values.game) {
    console.error("Missing --game GAME_ID");
    process.exit(2);
  }
  const cfg = readConfig();
  const session = getCurrentSession(values.game);
  const meta = readGameMeta(values.game);
  const lastIndex = meta.frame_count > 0 ? meta.frame_count - 1 : 0;
  const lastFrame = meta.frame_count > 0 ? readFrame(values.game, lastIndex) : null;
  console.log(
    JSON.stringify(
      {
        config: { currentCardId: cfg.currentCardId },
        session,
        last_frame_index: lastFrame?.index ?? null,
        last_state: lastFrame?.state ?? null,
        levels_completed: lastFrame?.levels_completed ?? meta.levels_completed ?? null,
        available_actions: lastFrame?.available_actions ?? [],
        frame_count: meta.frame_count,
      },
      null,
      2,
    ),
  );
}

main();
