/**
 * Action review (PLAN-53 Track B): which classes of agent action wait for the
 * owner's approval before they run.
 */
export type ReviewMode = "ask" | "allow";

export type ReviewConfig = {
  /**
   * Money leaving the wallet (send_usdc, send_to_peer, x402 pay_for_resource).
   * "ask" (default) holds the call until the owner approves it in the Control
   * UI or chat; a standing spend grant that covers the payee and amount passes
   * without asking. "allow" keeps only the wallet's numeric caps.
   */
  spend?: ReviewMode;
  /**
   * Public posts (the X channel). "ask" (default) holds the post for approval;
   * "allow" posts straight away, subject to the channel's own policy gate.
   */
  publish?: ReviewMode;
  /** How long a request waits for a decision before it expires. Default: 24. */
  ttlHours?: number;
};
