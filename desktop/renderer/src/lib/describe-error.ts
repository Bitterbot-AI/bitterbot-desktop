/**
 * PLAN-41 copy pass (p1-2 slice): raw transport/RPC errors are developer
 * strings. The top user-facing surfaces run them through this map so an
 * operator reads what happened and what to do, not a stack fragment.
 * Unrecognized messages pass through unchanged — never hide the real error.
 */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "Unknown error");
  const lower = raw.toLowerCase();
  if (lower.includes("unknown method")) {
    return "This gateway doesn't support that yet — it's likely running an older build. Update or restart the gateway.";
  }
  if (lower.includes("timeout")) {
    return "The gateway didn't answer in time. It may be busy or mid-restart; try again in a moment.";
  }
  if (
    lower.includes("disconnect") ||
    lower.includes("socket closed") ||
    lower.includes("connection closed") ||
    lower.includes("not connected")
  ) {
    return "Lost the gateway connection. This page reconnects on its own; retry once the badge shows connected.";
  }
  if (lower.includes("unauthorized") || lower.includes("auth")) {
    return "The gateway rejected this session's credentials. Reload the page to pick up a fresh token.";
  }
  if (lower.includes("basehash") || lower.includes("base hash")) {
    return "The config changed since this page loaded. Refresh and re-apply your change.";
  }
  return raw;
}
