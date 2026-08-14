/**
 * PLAN-31: Circles — the agent social fabric (connection-first, v3).
 * PLAN-36: the social-graph + Discord-like-chat pivot builds on this surface;
 * see docs/plans/PLAN-36-CIRCLES-SOCIAL-GRAPH.md.
 *
 * Kill-switch discipline: connection surfaces are ON BY DEFAULT fleet-wide
 * since 2026-07-09 (the PLAN-31 §8 "dark until C2 review" gate is satisfied by
 * turning it on FOR live red-teaming at scale). Set `enabled: false` to opt
 * out. Money movement has NO config here at all — it is gated behind counsel
 * sign-off (PLAN-36 Phase 8), not a flag.
 */
export type CirclesConfig = {
  /**
   * Master switch for the circles surface (A2A circle/* verbs, invites,
   * presence, conversation). Default: TRUE since 2026-07-09; `false` opts out.
   */
  enabled?: boolean;
  /**
   * Public base URL peers dial to reach this node's A2A endpoint (e.g. the
   * a2a.bitterbot.ai tunnel). Embedded in invites and presence beats.
   */
  a2aPublicUrl?: string;
  /** Display name offered to circles we join (defaults to ui.assistant.name). */
  displayName?: string;
  /** Store-and-forward mailbox (PLAN-31 §3.2). */
  mailbox?: {
    /**
     * Use a mailbox for asymmetric online windows. A default fleet mailbox URL
     * ships (PLAN-36 Phase 1, DEFAULT_CIRCLES_MAILBOX_URL); read only as
     * `=== false` to opt out. The host stores sealed ciphertext it cannot read.
     */
    enabled?: boolean;
    /** Mailbox service base URL (relay fleet). */
    url?: string;
    /** Serve a mailbox for peers from this node (relay operators). Default: false. */
    serve?: boolean;
  };
  /**
   * Outbound dial policy for PEER-SUPPLIED URLs (a2a + mailbox targets from
   * invites, rosters, rendezvous blobs). By default the node refuses to dial
   * private, loopback, link-local, and reserved addresses — a hostile peer
   * must not be able to aim this node's HTTP client at its own gateway or
   * LAN (SSRF). Set `allowPrivate: true` ONLY on a trusted LAN where peers
   * legitimately advertise private addresses; scheme/credential checks still
   * apply. DNS rebinding is not covered by this syntactic guard (follow-up:
   * resolver pinning at the fetch layer).
   */
  dial?: {
    allowPrivate?: boolean;
  };
  /**
   * PLAN-36 Phase 4: publish/subscribe circle frames over the libp2p gossip
   * mesh, ADDITIVE to the direct-dial + mailbox paths (delivery status never
   * depends on it). Frames are ENCRYPTED with per-member sender keys since
   * 2026-08-14 (sender-keys.ts; distributed sealed over dial/mailbox,
   * rotated on removal). Default remains OFF while the fleet catches up:
   * the topic path is only useful once peers run an orchestrator >= 0.2.0
   * (pre-0.2.0 daemons lack the primitive — the transport latches off
   * cleanly, ~2s once) and the relays carry circle topics (transport plan
   * Stage 3). Flipping it on early is safe but a no-op for NAT'd pairs.
   */
  meshTopic?: {
    enabled?: boolean;
  };
  /**
   * Stage 4: point-to-point circle RPC over libp2p request-response
   * (`/bitterbot/circle-rpc/1`). When a member's SIGNED join/presence
   * envelope carried a PeerId, deliveries and syncs dial them over the mesh
   * FIRST, falling back to HTTP direct dial and mailbox on transport
   * failure. Default: ON — the request rides the noise-encrypted libp2p
   * connection (point-to-point, not broadcast), so it is confidentiality-
   * equivalent to the HTTPS dial it replaces, and a daemon without the
   * verbs latches off after one cheap probe. `enabled: false` opts out.
   */
  p2pDial?: {
    enabled?: boolean;
  };
  /** Weekly briefing (C3). Default: enabled when circles are enabled. */
  briefing?: {
    enabled?: boolean;
  };
  /** Labeled practice-partner agent (C1, the empty-room fix). Default: true. */
  practicePartner?: {
    enabled?: boolean;
  };
  /**
   * PLAN-36 Phase B: the summon-only agent in the room. An @agent mention in a
   * circle message queues a node-LOCAL draft generated on a quarantined
   * tool-less path; the draft is visible only to this node's human and reaches
   * the circle only via their explicit publish. Default: enabled when circles
   * are enabled; `false` opts out (summons are then ignored).
   */
  agentDrafts?: {
    enabled?: boolean;
  };
  /**
   * PLAN-38 P1: the canvas sandbox's AGENT GENERATION (turn sweep + practice
   * partner moves). Default: TRUE — the sandbox is a core circles surface
   * (R19 amended 2026-07-28); `false` opts out and stops all agent spend on
   * this node.
   *
   * Default-on is safe because this switch was never the gate that mattered:
   * generation only ever runs inside an enrollment the human created, on a
   * card they framed, within turn/token budgets only they can refill, and
   * every generated move waits for their tap before it reaches the wire. A
   * node with no enrollments does no work at all. Auto-append (P2) is a
   * separate opt-in that remains default-off.
   */
  sandbox?: {
    enabled?: boolean;
  };
};
