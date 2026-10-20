import { prependSystemEvents } from "../../auto-reply/reply/session-updates.js";
import type { BitterbotConfig } from "../../config/config.js";
import { hasSystemEvents } from "../../infra/system-events.js";

/**
 * Put this session's queued system events in front of the prompt, the same
 * way the chat reply pipeline does, and take them off the queue.
 *
 * Without this a turn started through the `agent` command or RPC never saw
 * them: found on 2026-10-04, when an agent driven from the CLI was never told
 * its held payment had been approved.
 */
export async function withQueuedSystemEvents(params: {
  cfg: BitterbotConfig;
  sessionKey: string | undefined;
  body: string;
}): Promise<string> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !hasSystemEvents(sessionKey)) {
    return params.body;
  }
  return await prependSystemEvents({
    cfg: params.cfg,
    sessionKey,
    // Only the queue: the new-session channel summary belongs to chat turns.
    isMainSession: false,
    isNewSession: false,
    prefixedBodyBase: params.body,
  });
}
