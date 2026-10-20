/**
 * A spend that passes on a standing grant reserves its amount against the
 * grant straight away, so two calls racing for the last of an allowance cannot
 * both get through. If the send then fails, the reservation has to be given
 * back: before this, a failed send still used up the owner's allowance.
 *
 * The tool-result handler settles each reservation by (session, call
 * fingerprint), the same key the repeat-call guard uses.
 */

import { toolCallFingerprint } from "../agents/agent-tools.repeat-guard.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("review");

/** Calls that never report back (a crashed run) must not pile up. */
const MAX_OPEN = 200;

const open = new Map<string, () => void>();

const keyOf = (sessionKey: string | undefined, fingerprint: string) =>
  `${sessionKey ?? ""}|${fingerprint}`;

/** Remember how to give back what a passing call reserved. */
export function holdGrantReservation(
  sessionKey: string | undefined,
  fingerprint: string,
  release: () => void,
): void {
  open.set(keyOf(sessionKey, fingerprint), release);
  if (open.size > MAX_OPEN) {
    const oldest = open.keys().next().value;
    if (oldest !== undefined) {
      open.delete(oldest);
    }
  }
}

/** The call finished. A failure gives the reserved amount back to the grant. */
export function settleGrantReservation(params: {
  sessionKey: string | undefined;
  toolName: string;
  args: unknown;
  failed: boolean;
}): void {
  if (open.size === 0) {
    return;
  }
  const key = keyOf(params.sessionKey, toolCallFingerprint(params.toolName, params.args));
  const release = open.get(key);
  if (!release) {
    return;
  }
  open.delete(key);
  if (!params.failed) {
    return;
  }
  try {
    release();
    log.info(`released a grant reservation: the ${params.toolName} call failed`);
  } catch (err) {
    log.warn(`could not release a grant reservation: ${String(err)}`);
  }
}

export function resetGrantReservationsForTest(): void {
  open.clear();
}
