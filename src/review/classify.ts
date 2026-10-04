/**
 * Which tool calls need a person's approval, and how to show them (PLAN-53 B3).
 *
 * A pure function from (tool, params) to a class and a one-line preview. Only
 * two classes exist in version 1:
 *   - spend:   the wallet moving money (send_usdc, send_to_peer, pay_for_resource)
 *   - publish: a post to the X channel through the message tool
 * Everything else is unclassified and never reviewed here. Sends to other
 * people and shell commands are deliberately not in this version.
 */

export type ReviewClass = "spend" | "publish";

export type Classification = {
  cls: ReviewClass;
  /** One line a person can decide on: what, to whom, how much. */
  preview: string;
  /** For spend: the counterparty, as the spend-grant store keys it. */
  payee?: string;
  /** For spend: the amount in USD-equivalent (USDC is 1:1). */
  amountUsd?: number;
  /**
   * Required parameters the call left out. Such a call can never execute, so
   * it is sent back to the agent to correct instead of being put to the owner.
   */
  missing?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 160): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const money = (value: number | undefined): string =>
  value === undefined ? "an unspecified amount" : `${value} USDC`;

const SPEND_ACTIONS = new Set(["send_usdc", "send_to_peer", "pay_for_resource"]);

export function classifyToolCall(toolName: string, params: unknown): Classification | null {
  if (!isRecord(params)) {
    return null;
  }
  const name = toolName.trim().toLowerCase();

  if (name === "wallet") {
    const action = text(params.action);
    if (!SPEND_ACTIONS.has(action)) {
      return null;
    }
    const amountUsd = amount(params.amount);
    // The wallet tool requires these; name the ones the call left out.
    const target =
      action === "send_usdc" ? "address" : action === "send_to_peer" ? "peer_id" : "resource_url";
    const missing = [
      ...(text(params[target]) ? [] : [target]),
      ...(amountUsd === undefined ? ["amount"] : []),
    ];
    const invalid = missing.length > 0 ? { missing } : {};
    if (action === "send_usdc") {
      const payee = text(params.address) || "(no address)";
      return {
        cls: "spend",
        preview: `Send ${money(amountUsd)} to ${payee}`,
        payee,
        amountUsd,
        ...invalid,
      };
    }
    if (action === "send_to_peer") {
      const payee = text(params.peer_id) || "(no peer)";
      return {
        cls: "spend",
        preview: `Send ${money(amountUsd)} to peer ${payee}`,
        payee,
        amountUsd,
        ...invalid,
      };
    }
    const url = text(params.resource_url) || "(no URL)";
    const reason = text(params.reason, 80);
    return {
      cls: "spend",
      preview: `Pay ${money(amountUsd)} for ${url}${reason ? ` (${reason})` : ""}`,
      payee: url,
      amountUsd,
      ...invalid,
    };
  }

  if (name === "message") {
    const channel = text(params.channel).toLowerCase();
    const action = text(params.action).toLowerCase() || "send";
    if (channel !== "x" || action !== "send") {
      return null;
    }
    const body = text(params.message, 200) || "(empty post)";
    return { cls: "publish", preview: `Post to X: "${body}"` };
  }

  return null;
}
