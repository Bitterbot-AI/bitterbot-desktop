/**
 * PLAN-31: Circles — the agent social fabric (connection-first, v3).
 *
 * Kill-switch discipline (PLAN-31 §8): connection surfaces default OFF until
 * C2 completes its security review; pairing ships dark behind this config
 * until the invite guest page is live. Money movement has NO config here at
 * all — Phase 2 is gated behind counsel sign-off, not a flag.
 */
export type CirclesConfig = {
  /**
   * Master switch for the circles surface (A2A circle/* verbs, invites,
   * presence, conversation). Default: FALSE (ships dark, PLAN-31 §8).
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
    /** Use a mailbox for asymmetric online windows. Default: true when circles enabled. */
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
