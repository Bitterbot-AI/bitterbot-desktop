/**
 * The `purchase` tool (PLAN-53 C1, C4): buy something on a website with a
 * one-time card from the owner's Stripe Link account or, with
 * `rail: "privacy"`, a single-use card from their Privacy.com account.
 *
 * The owner approves every purchase: in the Link app for Link, in
 * Bitterbot's review queue for Privacy (the request is held as a spend and
 * the card is created only on approval). The card itself never reaches the
 * agent: `fill_card` makes the gateway type it into the checkout page's
 * fields, and the result says only the brand and last four digits.
 */

import { Type } from "@sinclair/typebox";
import { markCardEntry } from "../../browser/card-entry.js";
import { browserAct } from "../../browser/client-actions.js";
import { browserTabs } from "../../browser/client.js";
import type { BitterbotConfig } from "../../config/config.js";
import { gateCardPurchase } from "../../payments/ap2/gate.js";
import { createLinkCliRunner, resolveLinkSettings } from "../../payments/link/cli.js";
import { type CardForEntry, LinkRail } from "../../payments/link/rail.js";
import { PrivacyRail, resolvePrivacySettings, siteOf } from "../../payments/privacy/rail.js";
import { configureSpendGateForReview } from "../../review/spend.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const ACTIONS = ["status", "connect", "request", "check", "fill_card"] as const;

const Schema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "status (is Link connected) | connect (start connecting; give the owner the link and phrase) | request (ask the owner to approve one purchase) | check (has it been approved) | fill_card (type the approved card into the checkout page)",
  }),
  rail: Type.Optional(
    stringEnum(["link", "privacy"] as const, {
      description:
        'Which card: "link" (Stripe Link, the default when connected) or "privacy" (a single-use Privacy.com card, approved by the owner in Bitterbot). Pass the same rail on every step of one purchase.',
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: "Purchase id (lsrq_... for Link, prq_... for Privacy), for check and fill_card.",
    }),
  ),
  merchant_name: Type.Optional(Type.String({ description: "For request: the shop's name." })),
  merchant_url: Type.Optional(
    Type.String({ description: "For request: the shop's https address." }),
  ),
  amount_usd: Type.Optional(
    Type.Number({
      description: "For request: the total in US dollars, including shipping and tax.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "For request: at least 100 characters saying what is being bought and why. The owner reads this in Link before approving.",
    }),
  ),
  number_ref: Type.Optional(
    Type.String({ description: "For fill_card: snapshot ref of the card number field." }),
  ),
  expiry_ref: Type.Optional(
    Type.String({ description: 'For fill_card: ref of a single "MM / YY" expiry field.' }),
  ),
  exp_month_ref: Type.Optional(
    Type.String({ description: "For fill_card: ref of a separate expiry month field." }),
  ),
  exp_year_ref: Type.Optional(
    Type.String({ description: "For fill_card: ref of a separate expiry year field." }),
  ),
  cvc_ref: Type.Optional(
    Type.String({ description: "For fill_card: ref of the security code field." }),
  ),
  name_ref: Type.Optional(
    Type.String({ description: "For fill_card: ref of the cardholder name field, if any." }),
  ),
  targetId: Type.Optional(
    Type.String({ description: "For fill_card: the browser tab, from the snapshot." }),
  ),
  profile: Type.Optional(Type.String()),
});

export function createPurchaseTool(opts: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = opts.config;
  if (!cfg) {
    return null;
  }
  const settings = resolveLinkSettings(cfg);
  const privacySettings = resolvePrivacySettings(cfg);
  if (!settings.enabled && !privacySettings.enabled) {
    return null;
  }
  const rail = new LinkRail(settings, createLinkCliRunner(settings));
  const privacy = new PrivacyRail(privacySettings);

  const type = async (
    ref: string | undefined,
    text: string,
    targetId?: string,
    profile?: string,
  ) => {
    if (!ref) return false;
    // Before the first keystroke: no frame of this page is sent or recorded
    // while a card may be on it.
    markCardEntry();
    await browserAct(undefined, { kind: "type", ref, text, targetId }, { profile });
    return true;
  };

  const fillCard = async (card: CardForEntry, params: Record<string, unknown>) => {
    const numberRef = readStringParam(params, "number_ref", { required: true });
    const targetId = readStringParam(params, "targetId");
    const profile = readStringParam(params, "profile");
    const filled: string[] = [];
    const mm = String(card.expMonth).padStart(2, "0");
    const yy = String(card.expYear).slice(-2);
    if (await type(numberRef, card.number, targetId, profile)) filled.push("number");
    if (await type(readStringParam(params, "expiry_ref"), `${mm} / ${yy}`, targetId, profile))
      filled.push("expiry");
    if (await type(readStringParam(params, "exp_month_ref"), mm, targetId, profile))
      filled.push("expiry month");
    if (
      await type(readStringParam(params, "exp_year_ref"), String(card.expYear), targetId, profile)
    )
      filled.push("expiry year");
    if (card.cvc && (await type(readStringParam(params, "cvc_ref"), card.cvc, targetId, profile)))
      filled.push("security code");
    if (
      card.name &&
      (await type(readStringParam(params, "name_ref"), card.name, targetId, profile))
    )
      filled.push("name");
    return filled;
  };

  const runPrivacy = async (action: string, params: Record<string, unknown>) => {
    switch (action) {
      case "status":
        return jsonResult(await privacy.status());
      case "connect":
        return jsonResult({
          next: "Privacy.com connects with an API key, not a login: the owner creates one at privacy.com/account (a plan with API access) and sets payments.privacy.apiKey. Then call status.",
        });
      case "request": {
        // Reaching here means the owner approved this purchase in the review
        // queue (or chose to let spends through without asking).
        const view = await privacy.request({
          merchantName: readStringParam(params, "merchant_name", { required: true }),
          merchantUrl: readStringParam(params, "merchant_url", { required: true }),
          amountUsd: readNumberParam(params, "amount_usd", { required: true }),
        });
        return jsonResult({
          ...view,
          next: `Approved. Fill the checkout with fill_card, rail "privacy", id ${view.id}. The card works once, for at most $${view.amountUsd.toFixed(2)}.`,
        });
      }
      case "check":
        return jsonResult(await privacy.check(readStringParam(params, "id", { required: true })));
      case "fill_card": {
        const id = readStringParam(params, "id", { required: true });
        const request = await privacy.check(id);
        if (request.status !== "approved") {
          throw new Error(`Privacy purchase ${id} is ${request.status}. Nothing was filled.`);
        }
        readStringParam(params, "number_ref", { required: true });
        // The card goes only into a page on the shop the owner approved.
        const targetId = readStringParam(params, "targetId", { required: true });
        const tabs = await browserTabs(undefined, {
          profile: readStringParam(params, "profile"),
        }).catch(() => []);
        const tab = tabs.find((t) => t.targetId === targetId);
        let tabSite = "";
        try {
          tabSite = tab ? siteOf(new URL(tab.url).hostname) : "";
        } catch {
          tabSite = "";
        }
        const shopSite = siteOf(new URL(request.merchantUrl).hostname);
        if (!tabSite || tabSite !== shopSite) {
          throw new Error(
            `The checkout tab is not on ${shopSite}, the shop this purchase was approved for. Nothing was filled.`,
          );
        }
        configureSpendGateForReview();
        gateCardPurchase(
          {
            origin: "wallet-tool",
            sessionKey: opts.agentSessionKey,
            sessionCapUsd: cfg.tools?.wallet?.sessionSpendCapUsd ?? 50,
            purpose: request.merchantName,
          },
          { payee: request.merchantName, amountUsd: request.amountUsd, requestId: id },
        );
        let card: CardForEntry | null = await privacy.takeCard(id);
        try {
          const filled = await fillCard(card, params);
          return jsonResult({
            ok: true,
            card: `Privacy card ending ${card.last4}`,
            filled,
            next: "Check the order total on the page is at most the approved amount, then submit the order with the browser tool. The card closes after this one charge.",
          });
        } finally {
          card = null;
        }
      }
      default:
        throw new Error(`Unknown purchase action: ${action}. Use one of ${ACTIONS.join(", ")}.`);
    }
  };

  return {
    label: "Purchase",
    name: "purchase",
    description: [
      settings.enabled
        ? "Buy something on a website with a one-time card from the owner's Stripe Link account."
        : 'Buy something on a website with a single-use card from the owner\'s Privacy.com account (pass rail: "privacy" on every step).',
      "Steps: request (the owner approves) -> check until approved -> fill the shop's checkout form with fill_card using the field refs from a browser snapshot -> submit the order with the browser.",
      ...(settings.enabled && privacySettings.enabled
        ? [
            'If the owner prefers it or Link is not connected, use rail: "privacy" instead; the owner approves those in Bitterbot.',
          ]
        : []),
      "You never see the card number. Never ask the owner for card details, and never type a card yourself.",
      `One purchase may be at most $${settings.enabled ? settings.perPurchaseCapUsd : privacySettings.perPurchaseCapUsd}.`,
    ].join(" "),
    parameters: Schema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const railName = readStringParam(params, "rail");
      if (railName === "privacy" || (!settings.enabled && railName !== "link")) {
        if (!privacySettings.enabled) {
          throw new Error("Privacy.com purchases are off (payments.privacy.enabled).");
        }
        // The review stage holds a Privacy request only when it says so; a
        // request that left the rail out must not create a card unreviewed.
        if (railName !== "privacy") {
          throw new Error('Pass rail: "privacy" for a Privacy.com purchase.');
        }
        return await runPrivacy(action, params);
      }
      if (!settings.enabled) {
        throw new Error("Link purchases are off (payments.link.enabled).");
      }
      switch (action) {
        case "status":
          return jsonResult(await rail.status());
        case "connect": {
          const started = await rail.connect();
          return jsonResult({
            verificationUrl: started.verificationUrl,
            phrase: started.phrase,
            next: "Give the owner this link and phrase. They open it, log in to Link and enter the phrase. Then call status.",
          });
        }
        case "request": {
          const amountUsd = readNumberParam(params, "amount_usd", { required: true });
          if (amountUsd > settings.perPurchaseCapUsd) {
            throw new Error(
              `$${amountUsd} is above the per-purchase limit of $${settings.perPurchaseCapUsd} (payments.link.perPurchaseCapUsd).`,
            );
          }
          const view = await rail.request({
            merchantName: readStringParam(params, "merchant_name", { required: true }),
            merchantUrl: readStringParam(params, "merchant_url", { required: true }),
            amountUsd,
            context: readStringParam(params, "context", { required: true }),
          });
          return jsonResult({
            ...view,
            next: "The owner has been asked to approve this in the Link app. Call check with the id; do not fill a form until it is approved.",
          });
        }
        case "check":
          return jsonResult(await rail.check(readStringParam(params, "id", { required: true })));
        case "fill_card": {
          const id = readStringParam(params, "id", { required: true });
          const request = await rail.check(id);
          if (request.status !== "approved") {
            throw new Error(
              `Spend request ${id} is ${request.status}, not approved. Nothing was filled.`,
            );
          }
          readStringParam(params, "number_ref", { required: true });
          configureSpendGateForReview();
          gateCardPurchase(
            {
              origin: "wallet-tool",
              sessionKey: opts.agentSessionKey,
              sessionCapUsd: cfg.tools?.wallet?.sessionSpendCapUsd ?? 50,
              purpose: request.merchantName,
            },
            {
              payee: request.merchantName ?? "merchant",
              amountUsd: request.amountUsd ?? 0,
              requestId: id,
            },
          );
          let card: CardForEntry | null = await rail.takeCard(id);
          try {
            const filled = await fillCard(card, params);
            return jsonResult({
              ok: true,
              card: `${card.brand ?? "card"} ending ${card.last4}`,
              filled,
              next: "Check the order total on the page matches the approved amount, then submit the order with the browser tool.",
            });
          } finally {
            card = null;
          }
        }
        default:
          throw new Error(`Unknown purchase action: ${action}. Use one of ${ACTIONS.join(", ")}.`);
      }
    },
  };
}
