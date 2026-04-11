/**
 * Process-wide live P2P status, updated by the gateway's orchestrator
 * bridge and read by anything that needs to know whether the agent is
 * actually on the network right now (e.g. system prompt, doctor, UI).
 *
 * This is a deliberately simple module-level singleton instead of
 * threaded params: the system prompt is built deep in the agent
 * request path and plumbing live state through every caller would be
 * a refactor sprawl with no benefit. The bridge has a single instance
 * per gateway process and writes here whenever its state changes.
 */

export type P2pStatusSnapshot = {
  /** True once the gateway has started and not yet shut down. */
  enabled: boolean;
  /** True if the orchestrator IPC socket is connected and at least one peer is currently connected. */
  connected: boolean;
  /** Currently connected peer count (gossipsub mesh size). */
  peerCount: number;
  /** Most recent unrecoverable bridge error, if any. */
  lastError: string | null;
};

const initial: P2pStatusSnapshot = {
  enabled: false,
  connected: false,
  peerCount: 0,
  lastError: null,
};

let current: P2pStatusSnapshot = { ...initial };

/** Read the current snapshot. Cheap; safe to call from hot paths. */
export function getP2pStatus(): P2pStatusSnapshot {
  return current;
}

/** Replace the entire snapshot. Used by the bridge on lifecycle events. */
export function setP2pStatus(snapshot: P2pStatusSnapshot): void {
  current = snapshot;
}

/** Patch a subset of fields. Used by per-event handlers. */
export function patchP2pStatus(patch: Partial<P2pStatusSnapshot>): void {
  current = { ...current, ...patch };
}

/** Reset to the initial state. For tests and gateway shutdown. */
export function resetP2pStatus(): void {
  current = { ...initial };
}
