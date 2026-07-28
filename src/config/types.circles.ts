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
