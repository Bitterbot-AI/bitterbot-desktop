/**
 * Which connections get tool OUTPUT with their tool events (PLAN-53 A4).
 *
 * Tool events reach WS clients with `result` and `partialResult` stripped
 * unless the session runs at verbose=full (866c6891). That gate is right for
 * channels, and wrong as the only switch for the Control UI: the owner's
 * terminal view had commands and no output, and raising verbosity on a shared
 * session would also start sending tool output into chat channels.
 *
 * So output is a lease, like the live browser view. A Control UI window asks
 * for it (operator.admin), renews while its pane is open, and only that
 * connection gets the unstripped event. Nothing changes for anyone else.
 */

/** A holder must renew within this window. */
export const TOOL_OUTPUT_LEASE_MS = 30_000;

export function createToolOutputLeases(now: () => number = Date.now) {
  const leases = new Map<string, number>();

  const live = (connId: string): boolean => {
    const expiresAt = leases.get(connId);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= now()) {
      leases.delete(connId);
      return false;
    }
    return true;
  };

  return {
    grant(connId: string): void {
      leases.set(connId, now() + TOOL_OUTPUT_LEASE_MS);
    },
    revoke(connId: string): void {
      leases.delete(connId);
    },
    has: live,
    /** Split an event's recipients into those who get the output and those who do not. */
    split(recipients: ReadonlySet<string>): { withOutput: Set<string>; stripped: Set<string> } {
      const withOutput = new Set<string>();
      const stripped = new Set<string>();
      for (const connId of recipients) {
        (live(connId) ? withOutput : stripped).add(connId);
      }
      return { withOutput, stripped };
    },
  };
}

export type ToolOutputLeases = ReturnType<typeof createToolOutputLeases>;

/** The gateway's one set of leases: granted by the RPC, read by the event handler. */
export const toolOutputLeases = createToolOutputLeases();
