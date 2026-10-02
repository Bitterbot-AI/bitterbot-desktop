/**
 * PLAN-52 Phase 1: open a session transcript with the store the engine selects.
 *
 * Both stores read and write session JSONL v3 and expose the same methods, so
 * callers take either. The return type is the owned `TranscriptStore`; pi's
 * `SessionManager` is adapted to it in `engines/pi/open-transcript.ts`.
 */

import { loadConfig, type BitterbotConfig } from "../../config/config.js";
import { DEFAULT_RUNTIME_ENGINE, resolveRuntimeEngine, type RuntimeEngine } from "./engine.js";
import { openPiTranscript } from "./engines/pi/open-transcript.js";
import { TranscriptStore } from "./transcript/store.js";

export function openTranscript(sessionFile: string, engine: RuntimeEngine): TranscriptStore {
  return engine === "bitterbot" ? TranscriptStore.open(sessionFile) : openPiTranscript(sessionFile);
}

/**
 * Open a transcript outside a run (delivery mirror, chat inject, thread fork)
 * with the store of the agent's configured engine. The config is loaded when
 * the caller does not have it; if that fails the default engine is used.
 */
export function openTranscriptForAgent(
  sessionFile: string,
  params: { config?: BitterbotConfig; agentId?: string } = {},
): TranscriptStore {
  let engine: RuntimeEngine = DEFAULT_RUNTIME_ENGINE;
  try {
    engine = resolveRuntimeEngine(params.config ?? loadConfig(), params.agentId);
  } catch {
    // Unreadable config: the default engine's store reads the same format.
  }
  return openTranscript(sessionFile, engine);
}
