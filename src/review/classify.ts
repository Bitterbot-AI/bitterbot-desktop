/**
 * Which tool calls need a person's approval, and how to show them (PLAN-53 B3).
 *
 * A pure function from (tool, params) to a class and a one-line preview. The
 * classes:
 *   - spend:   the wallet moving money (send_usdc, send_to_peer, pay_for_resource)
 *   - publish: a post to the X channel through the message tool
 *   - contact: a message the agent addresses to a named recipient. Whether
 *              that recipient is new is not decided here (see contacts.ts).
 * Everything else is unclassified and never reviewed here; shell commands
 * have their own approvals.
 */

import { getConnectorTool } from "./connectors.js";

export type ReviewClass = "spend" | "publish" | "contact" | "connector";

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
  /** For contact: who the message goes to, as the call named them. */
  recipients?: ContactRecipient[];
};

/** One addressee of a message. `channel` is absent when the call left it to the run. */
export type ContactRecipient = { channel?: string; target: string };

/** Message-tool actions that put new content in front of someone. */
const CONTACT_ACTIONS = new Set([
  "send",
  "sendwitheffect",
  "sendattachment",
  "reply",
  "thread-reply",
  "poll",
  "sticker",
  "broadcast",
]);

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
  // A connector tool that changes something (D5). Registered by the connector.
  const connector = getConnectorTool(toolName.trim());
  if (connector) {
    if (connector.readOnly || connector.trustWrites) {
      return null;
    }
    const args = isRecord(params) ? JSON.stringify(params) : "";
    return {
      cls: "connector",
      preview: `${connector.server}: ${connector.tool}${args && args !== "{}" ? ` ${args.slice(0, 200)}` : ""}`,
    };
  }
  if (!isRecord(params)) {
    return null;
  }
  const name = toolName.trim().toLowerCase();

  // A Privacy.com purchase (C4): Privacy has no approval of its own, so the
  // request that creates the card is the owner's decision. Link requests are
  // approved in the Link app and are not held here.
  if (name === "purchase" && text(params.action) === "request" && text(params.rail) === "privacy") {
    const amountUsd = amount(params.amount_usd);
    const merchant = text(params.merchant_name) || "(no merchant)";
    const missing = [
      ...(text(params.merchant_name) ? [] : ["merchant_name"]),
      ...(text(params.merchant_url) ? [] : ["merchant_url"]),
      ...(amountUsd === undefined ? ["amount_usd"] : []),
    ];
    const why = text(params.context, 120);
    return {
      cls: "spend",
      preview: `Buy from ${merchant} for up to $${amountUsd?.toFixed(2) ?? "?"} with a single-use Privacy card${why ? `: ${why}` : ""}`,
      payee: merchant,
      amountUsd,
      ...(missing.length > 0 ? { missing } : {}),
    };
  }

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
    if (channel === "x") {
      if (action !== "send") {
        return null;
      }
      const post = text(params.message, 200) || "(empty post)";
      return { cls: "publish", preview: `Post to X: "${post}"` };
    }
    // A dry run sends nothing.
    if (!CONTACT_ACTIONS.has(action) || params.dryRun === true) {
      return null;
    }
    // Broadcast names its recipients in `targets`; everything else in `target`
    // (or the older `to` / `channelId`). With none of them the message goes to
    // the conversation the agent is already in, which is not a new contact.
    const named =
      action === "broadcast"
        ? Array.isArray(params.targets)
          ? params.targets.map((t) => text(t))
          : []
        : [text(params.target) || text(params.to) || text(params.channelId)];
    const targets = named.filter((t) => t.length > 0);
    if (targets.length === 0) {
      return null;
    }
    const where = channel && channel !== "all" ? channel : undefined;
    const recipients = targets.map((target) => ({
      ...(where ? { channel: where } : {}),
      target,
    }));
    const body = text(params.message, 160) || text(params.caption, 160) || `(${action}, no text)`;
    const to =
      recipients.length === 1
        ? `${where ? `${where} ` : ""}${recipients[0].target}`
        : `${recipients.length} recipients${where ? ` on ${where}` : ""} (${targets.slice(0, 3).join(", ")}${targets.length > 3 ? ", ..." : ""})`;
    return { cls: "contact", preview: `Message ${to}: "${body}"`, recipients };
  }

  return null;
}
