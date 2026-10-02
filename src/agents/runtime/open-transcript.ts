/**
 * PLAN-52 Phase 1: open a session transcript with the store the engine selects.
 *
 * Both stores read and write session JSONL v3 and expose the same methods, so
 * callers (and pi's own session layer, which still drives the turn until
 * Phase 4) take either. The return type is pi's `SessionManager` because that
 * is what `createAgentSession` and the tool-result guard are typed against;
 * the cast is removed with the pi engine.
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { RuntimeEngine } from "./engine.js";
import { TranscriptStore } from "./transcript/store.js";

export function openTranscript(sessionFile: string, engine: RuntimeEngine): SessionManager {
  if (engine === "bitterbot") {
    return TranscriptStore.open(sessionFile) as unknown as SessionManager;
  }
  return SessionManager.open(sessionFile);
}
