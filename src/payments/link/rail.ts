/**
 * The Link rail (PLAN-53 C1): buy something with a one-time card from the
 * owner's Link account.
 *
 *   1. connect: the owner approves Bitterbot in the Link app (once).
 *   2. request: a spend request for one merchant, one amount, with what and
 *      why. The owner approves it in the Link app; that is the approval.
 *   3. check: wait for the decision.
 *   4. fill: the gateway types the card into the checkout page. The card is
 *      written by the CLI to a 0600 file, read once here, and deleted; the
 *      agent only ever sees the brand and last four digits.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LinkCliRunner, LinkSettings } from "./cli.js";

export type LinkStatus = { connected: boolean; detail?: string };

export type SpendRequestView = {
  id: string;
  status: string;
  merchantName?: string;
  amountUsd?: number;
  approvalUrl?: string;
  /** What the owner or the agent has to do next, in Link's words. */
  nextAction?: string;
  card?: { brand?: string; last4?: string };
};

export type CardForEntry = {
  number: string;
  cvc?: string;
  expMonth: number;
  expYear: number;
  name?: string;
  brand?: string;
  last4: string;
};

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});

/** The CLI wraps results in different envelopes depending on command; find the object. */
function unwrap(result: unknown): Raw {
  const r = obj(result);
  if (r.data && typeof r.data === "object") return obj(r.data);
  if (r.spend_request && typeof r.spend_request === "object") return obj(r.spend_request);
  return r;
}

function toView(raw: unknown): SpendRequestView {
  const r = unwrap(raw);
  const amount = num(r.amount);
  const card = obj(r.card);
  const next = obj(obj(obj(r.status_details).requires_action).next_action);
  return {
    id: str(r.id) ?? "",
    status: str(r.status) ?? "unknown",
    merchantName: str(r.merchant_name),
    amountUsd: amount !== undefined ? amount / 100 : undefined,
    approvalUrl: str(r.approval_url),
    nextAction: str(next.display_message),
    ...(card.brand || card.last4 || r.card_last4
      ? {
          card: {
            brand: str(card.brand) ?? str(r.card_brand),
            last4: str(card.last4) ?? str(r.card_last4),
          },
        }
      : {}),
  };
}

export class LinkRail {
  constructor(
    private readonly settings: LinkSettings,
    private readonly run: LinkCliRunner,
  ) {}

  async status(): Promise<LinkStatus> {
    try {
      const r = unwrap(await this.run(["auth", "status"]));
      return { connected: r.authenticated === true };
    } catch (err) {
      return { connected: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Start connecting. Returns where the owner goes and the phrase to enter. */
  async connect(): Promise<{ verificationUrl?: string; phrase?: string; raw: Raw }> {
    await fs.mkdir(path.dirname(this.settings.authFile), { recursive: true, mode: 0o700 });
    const r = unwrap(await this.run(["auth", "login", "--client-name", "Bitterbot"]));
    return {
      verificationUrl:
        str(r.verification_uri_complete) ??
        str(r.verification_uri) ??
        str(r.verification_url) ??
        str(r.url),
      phrase: str(r.user_code) ?? str(r.phrase) ?? str(r.code),
      raw: r,
    };
  }

  async request(input: {
    merchantName: string;
    merchantUrl: string;
    amountUsd: number;
    context: string;
  }): Promise<SpendRequestView> {
    if (input.context.trim().length < 100) {
      throw new Error(
        "Say what is being bought and why in at least 100 characters; the owner reads it in Link before approving.",
      );
    }
    let url: URL;
    try {
      url = new URL(input.merchantUrl);
    } catch {
      throw new Error("merchant_url must be the merchant's full https address");
    }
    if (url.protocol !== "https:") {
      throw new Error("merchant_url must be https");
    }
    const cents = Math.round(input.amountUsd * 100);
    if (!(cents > 0)) {
      throw new Error("amount must be a positive number of US dollars");
    }
    return toView(
      await this.run([
        "spend-request",
        "create",
        "--merchant-name",
        input.merchantName,
        "--merchant-url",
        url.toString(),
        "--context",
        input.context,
        "--amount",
        String(cents),
        "--request-approval",
      ]),
    );
  }

  async check(id: string): Promise<SpendRequestView> {
    return toView(await this.run(["spend-request", "retrieve", id]));
  }

  /**
   * Fetch the approved card into a private file, read it once, delete it.
   * The returned value must only ever be typed into a page, never returned to
   * the model or logged.
   */
  async takeCard(id: string): Promise<CardForEntry> {
    await fs.mkdir(this.settings.cardDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.settings.cardDir, `${crypto.randomBytes(8).toString("hex")}.json`);
    try {
      await this.run(["spend-request", "retrieve", id, "--include", "card", "--output-file", file]);
      const card = obj(JSON.parse(await fs.readFile(file, "utf8")));
      const inner = card.card ? obj(card.card) : card;
      const number = str(inner.number)?.replace(/\s+/g, "");
      const expMonth = num(inner.exp_month);
      const expYear = num(inner.exp_year);
      if (!number || expMonth === undefined || expYear === undefined) {
        throw new Error("Link returned no usable card for this request; is it approved?");
      }
      return {
        number,
        cvc: str(inner.cvc),
        expMonth,
        expYear,
        name: str(obj(inner.billing_address).name),
        brand: str(inner.brand),
        last4: number.slice(-4),
      };
    } finally {
      await fs.rm(file, { force: true });
    }
  }
}
