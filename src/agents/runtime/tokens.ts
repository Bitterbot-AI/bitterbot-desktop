/**
 * Token estimate for one message (chars / 4, images counted separately), for
 * callers that hold agent messages. The implementation is the owned port in
 * `compaction/summary/tokens.ts`; this wrapper only adapts the message type.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  estimateTokens as estimateSessionMessageTokens,
  type SessionMessage,
} from "./compaction/summary/index.js";

export function estimateTokens(message: AgentMessage): number {
  return estimateSessionMessageTokens(message as unknown as SessionMessage);
}
