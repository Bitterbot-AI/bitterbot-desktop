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
  /**
   * Messages the agent addresses to a named recipient. "first" (default) holds
   * only a message to someone it has never dealt with: no session with them,
   * not the owner, not allow-listed or paired, not approved before. "ask"
   * holds every such message; "allow" holds none. Replies in the current
   * conversation are never held.
   */
  contact?: "first" | "ask" | "allow";
  /**
   * Connector tools (MCP servers) that change something: "ask" (default) holds
   * the call for approval; "allow" runs it. Tools a server declares read-only
   * always run, and a connector marked trustWrites skips this.
   */
  connector?: "ask" | "allow";
  /** How long a request waits for a decision before it expires. Default: 24. */
  ttlHours?: number;
};
