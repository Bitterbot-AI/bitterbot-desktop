/**
 * Process-wide wallet discoverability state.
 *
 * Two things live here, both deliberately a simple module-level singleton
 * rather than threaded params (same rationale as p2p-status.ts — the readers
 * are deep in the tool/agent-card paths and plumbing live state through every
 * caller would be refactor sprawl):
 *
 *  - our LOCAL wallet capability (address/network), set once at startup when
 *    the gateway advertises it to the mesh. Read by the A2A agent card and the
 *    network_status tool so they surface the live address without
 *    re-initializing the CDP wallet on a hot path.
 *  - a map of PEER wallet capabilities learned from `wallet_capability`
 *    telemetry gossiped by other Bitterbot nodes. Read by the wallet tool's
 *    send_to_peer action and the network_status `wallets` action so the agent
 *    can pay a peer by peerId without knowing its address out-of-band.
 *
 * Addresses are public information; advertising a receiving address does not
 * expose any signing capability.
 */

export type WalletCapability = {
  /** libp2p peer ID of the advertising node. Omitted for the local entry. */
  peerId?: string;
  /** Receiving address (0x..., Base). */
  address: string;
  /** Network the address lives on ("base" | "base-sepolia"). */
  network: string;
  /** Whether the node accepts inbound payments. */
  acceptsPayments: boolean;
  /** Whether the node also exposes an A2A endpoint. */
  a2aEnabled?: boolean;
  /**
   * Public base URL of the node's A2A endpoint, when one is configured.
   * Lets peers resolve peerId -> URL and hire this node without an
   * out-of-band address exchange (the cheapest possible discovery directory).
   */
  a2aUrl?: string;
  /** ms epoch when this entry was recorded/refreshed. */
  updatedAt: number;
};

/**
 * Peer entries older than this are treated as stale and ignored. The
 * advertise cadence is 30 min, so this allows a couple of missed beats before
 * we stop trusting a peer's address.
 */
export const PEER_WALLET_TTL_MS = 95 * 60 * 1000;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

let localCapability: WalletCapability | null = null;
const peerWallets = new Map<string, WalletCapability>();

/** Set (or clear) our own advertised wallet capability. */
export function setLocalWalletCapability(cap: WalletCapability | null): void {
  localCapability = cap;
}

/** Read our own advertised wallet capability, if the wallet is configured. */
export function getLocalWalletCapability(): WalletCapability | null {
  return localCapability;
}

/**
 * Record a peer's advertised wallet capability from a telemetry event.
 * Returns true if accepted (correct signal type, present peerId, valid EVM
 * address), false otherwise. Keyed by the author's libp2p peer ID.
 */
export function recordPeerWalletCapability(event: {
  signal_type: string;
  data: unknown;
  author_peer_id: string;
  timestamp?: number;
}): boolean {
  if (event.signal_type !== "wallet_capability") {
    return false;
  }
  const peerId = event.author_peer_id;
  if (!peerId) {
    return false;
  }
  const data = (event.data ?? {}) as Record<string, unknown>;
  const address = typeof data.address === "string" ? data.address : "";
  if (!EVM_ADDRESS_RE.test(address)) {
    return false;
  }
  const a2aUrl =
    typeof data.a2aUrl === "string" && /^https?:\/\//.test(data.a2aUrl) ? data.a2aUrl : undefined;
  peerWallets.set(peerId, {
    peerId,
    address,
    network: typeof data.network === "string" ? data.network : "base",
    // Default to accepting unless the peer explicitly opts out.
    acceptsPayments: data.acceptsPayments !== false,
    a2aEnabled: data.a2aEnabled === true,
    a2aUrl,
    updatedAt: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
  });
  return true;
}

/** Look up a peer's wallet capability, returning null if absent or stale. */
export function getPeerWalletCapability(
  peerId: string,
  now: number = Date.now(),
): WalletCapability | null {
  const cap = peerWallets.get(peerId);
  if (!cap) {
    return null;
  }
  if (now - cap.updatedAt > PEER_WALLET_TTL_MS) {
    return null;
  }
  return cap;
}

/** List all fresh peer wallet capabilities, most-recently-seen first. */
export function listPeerWalletCapabilities(now: number = Date.now()): WalletCapability[] {
  const fresh: WalletCapability[] = [];
  for (const cap of peerWallets.values()) {
    if (now - cap.updatedAt <= PEER_WALLET_TTL_MS) {
      fresh.push(cap);
    }
  }
  return fresh.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/** Reset all discovery state. For tests and gateway shutdown. */
export function resetWalletDiscovery(): void {
  localCapability = null;
  peerWallets.clear();
}
