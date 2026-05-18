#!/usr/bin/env -S node --import=tsx
/**
 * actions/action.ts
 *
 * Submits one action to the current game session. Persists the next
 * frame, updates session metadata, prints a one-line summary.
 *
 * Usage:
 *   node --import=tsx actions/action.ts --game GAME_ID --type 1..7 [--x X --y Y] [--reasoning JSON]
 *
 * Notes:
 *   - --type 6 requires --x and --y in [0, 63].
 *   - --type 1..4 = up/down/left/right; --type 5 = contextual; --type 7 = undo.
 *   - --reasoning is opaque JSON (≤16 KB) attached to the server-side recording.
 */

import { parseArgs } from "node:util";
import { ArcClient } from "../src/arc-client.js";
import {
  getCurrentSession,
  persistFrameResponse,
  readConfig,
  readFrame,
  upsertSession,
} from "../src/state.js";
import {
  coordinateAction,
  simpleAction,
  type ArcActionId,
  type ReasoningBlob,
} from "../src/types.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      game: { type: "string", default: "" },
      type: { type: "string", default: "" },
      x: { type: "string", default: "" },
      y: { type: "string", default: "" },
      reasoning: { type: "string", default: "" },
    },
    strict: false,
  });
  if (!values.game) {
    console.error("Missing --game GAME_ID");
    process.exit(2);
  }
  const typeNum = Number(values.type);
  if (!Number.isInteger(typeNum) || typeNum < 1 || typeNum > 7) {
    console.error("--type must be an integer in [1, 7]");
    process.exit(2);
  }
  let reasoning: ReasoningBlob | undefined;
  if (values.reasoning) {
    try {
      reasoning = JSON.parse(values.reasoning) as ReasoningBlob;
    } catch {
      console.error("--reasoning must be valid JSON");
      process.exit(2);
    }
  }

  const cfg = readConfig();
  void cfg; // not used here; reading is cheap and ensures file exists.
  const session = getCurrentSession(values.game);
  if (!session) {
    console.error(`No active session for ${values.game}. Run start-game.ts first.`);
    process.exit(2);
  }

  const client = new ArcClient();
  const action =
    typeNum === 6
      ? coordinateAction(Number(values.x), Number(values.y), reasoning)
      : simpleAction(typeNum as ArcActionId, reasoning);
  const prevFrame = readFrame(values.game, session.actions_submitted)?.frame;
  const frame = await client.act({ gameId: values.game, guid: session.guid, action });
  const { index } = persistFrameResponse({
    gameId: values.game,
    response: frame,
    prevFrame,
  });
  upsertSession({
    ...session,
    last_state: frame.state,
    levels_completed: frame.levels_completed,
    actions_submitted: session.actions_submitted + 1,
  });
  console.log(
    JSON.stringify({
      action: typeNum,
      x: typeNum === 6 ? Number(values.x) : undefined,
      y: typeNum === 6 ? Number(values.y) : undefined,
      state: frame.state,
      levels_completed: frame.levels_completed,
      available_actions: frame.available_actions,
      frame_index: index,
    }),
  );
}

main().catch((err) => {
  console.error("action failed:", err);
  process.exit(1);
});
