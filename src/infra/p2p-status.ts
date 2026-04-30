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
 *
 * The snapshot has two tiers:
 *   - lifecycle fields (enabled, connected, peerCount, lastError) are
 *     written eagerly from libp2p connection callbacks.
 *   - census fields (peerId, nodeTier, peersByTier, networkHealthScore,
 *     skillsPublishedNetworkWide, telemetryCountsByType, anomalyAlertCount,
 *     censusUpdatedAt) are refreshed on a slow poll (~30s) so the agent
 *     gets a useful snapshot every turn without a synchronous IPC round-trip
 *     on the prompt-build hot path.
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

  // Identity (set once on bridge connect, stable until restart)
  /** Our libp2p peer ID. Truncated when rendered for prompts. */
  peerId: string | null;
  /** Our node tier ("edge" | "management"). */
  nodeTier: string | null;

  // Census fields (refreshed periodically by the bridge poller)
  /** Live peer count by tier (e.g. {edge: 3, management: 3}). */
  peersByTier: Record<string, number>;
  /** Network health score (0..1). null = no census yet. */
  networkHealthScore: number | null;
  /** Total skills published network-wide (management census). */
  skillsPublishedNetworkWide: number | null;
  /** Telemetry signal counts by signal_type (rolling). */
  telemetryCountsByType: Record<string, number>;
  /** Active anomaly alerts. Empty when none. */
  anomalyAlertCount: number;
  /** Timestamp (ms epoch) of the last census patch, for staleness checks. */
  censusUpdatedAt: number | null;
};

const initial: P2pStatusSnapshot = {
  enabled: false,
  connected: false,
  peerCount: 0,
  lastError: null,
  peerId: null,
  nodeTier: null,
  peersByTier: {},
  networkHealthScore: null,
  skillsPublishedNetworkWide: null,
  telemetryCountsByType: {},
  anomalyAlertCount: 0,
  censusUpdatedAt: null,
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
