/**
 * PLAN-52 Phase 1: open a session transcript (session JSONL v3) with the
 * owned `TranscriptStore`. The engine parameter went with the pi engine;
 * `openTranscriptForAgent` stays so callers outside a run (delivery mirror,
 * chat inject, thread fork) keep one entry point.
 */

import type { BitterbotConfig } from "../../config/config.js";
import { TranscriptStore } from "./transcript/store.js";

export function openTranscript(sessionFile: string): TranscriptStore {
  return TranscriptStore.open(sessionFile);
}

export function openTranscriptForAgent(
  sessionFile: string,
  _params: { config?: BitterbotConfig; agentId?: string } = {},
): TranscriptStore {
  return TranscriptStore.open(sessionFile);
}
