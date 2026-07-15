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
     * Use a mailbox for asymmetric online windows. Only takes effect once a
     * `url` is set; no default mailbox URL ships yet (PLAN-36 Phase 1 adds a
     * default fleet mailbox). Read only as `=== false` to opt out.
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
};
