export type P2pConfig = {
  /** Enable the P2P orchestrator daemon. Default: true. */
  enabled?: boolean;
  /** Path to the orchestrator binary. */
  orchestratorBinary?: string;
  /** libp2p listen addresses. */
  listenAddrs?: string[];
  /** Initial bootstrap peer multiaddresses. */
  bootstrapPeers?: string[];
  /**
   * DNS domain for bootstrap peer discovery.
   * Resolves `_dnsaddr.<domain>` TXT records to find bootstrap peer multiaddresses.
   * Combined with any hardcoded `bootstrapPeers`. Example: "p2p.bitterbot.ai"
   */
  bootstrapDns?: string;
  /** Directory containing Ed25519 keypair for node identity. */
  keyDir?: string;
  /** Gossipsub topic subscriptions. */
  topics?: {
    skills?: boolean;
    telemetry?: boolean;
  };
  /** Security settings for the P2P network. */
  security?: {
    /** Maximum skill payload size in bytes. Default: 262144 (256KB). */
    maxSkillSizeBytes?: number;
    /** Maximum skills per minute per peer. Default: 10. */
    maxSkillsPerMinutePerPeer?: number;
    /** Require Ed25519 signature on all skill envelopes. Default: true. */
    requireSignature?: boolean;
  };
  /** HTTP API address for the orchestrator dashboard. Default: "127.0.0.1:9847". */
  httpAddr?: string;
  /** Bearer token for authenticating HTTP API requests. If unset, no auth is required. */
  httpAuthToken?: string;
  /** Node tier. Default: "edge". Set to "management" only if this node's pubkey is in the genesis trust list. */
  nodeTier?: "edge" | "management";
  /** Path to the genesis trust list file (one base64 pubkey per line). */
  genesisTrustListPath?: string;
  /** Inline genesis trust list: base64 Ed25519 pubkeys of authorized management nodes. */
  genesisTrustList?: string[];
  /** Relay mode for NAT traversal. Default: "auto" (server for management, client for edge). */
  relayMode?: "off" | "client" | "server" | "auto";
  /** Relay server multiaddresses for NAT traversal. Used in client/auto mode. */
  relayServers?: string[];
};
