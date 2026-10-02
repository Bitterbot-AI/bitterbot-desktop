/**
 * pi's SessionManager as a transcript store, for the "pi" engine. It has the
 * same public methods as the owned TranscriptStore; the cast is the adapter.
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { TranscriptStore } from "../../transcript/store.js";

export function openPiTranscript(sessionFile: string): TranscriptStore {
  return SessionManager.open(sessionFile) as unknown as TranscriptStore;
}
