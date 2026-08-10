// Shared list of the actual message-sending tool names the builtin
// interceptors bind to. This existed as three divergent copies that all
// listed phantom names (send_message, discord_send, ...) — none of which are
// real registered tools — so the interceptors could NEVER activate and
// intervention_records stayed empty forever (audit 2026-08-09, F4). The real
// tools are `message` (message-tool.ts) and `sessions_send`
// (sessions-send-tool.ts). Kept as ONE constant so a future tool rename can't
// silently re-break the whole PLAN-20 guard chain.
export const MESSAGE_TOOL_NAMES: readonly string[] = ["message", "sessions_send"];
