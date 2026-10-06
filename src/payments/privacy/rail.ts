/**
 * The Privacy.com rail (PLAN-53 C4): buy something with a single-use virtual
 * card from the owner's own Privacy.com account, for owners without Link.
 *
 * Privacy has no approval step of its own, so the owner approves each
 * purchase in Bitterbot's review queue (the `purchase` request is classified
 * as a spend). Only then is the card created, single-use and capped at the
 * approved amount. The card number never reaches the agent: it is read from
 * Privacy when the checkout form is filled and typed into the page. Locally
 * only the card token, merchant and amount are kept. A card left unused for
 * a day is closed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import type { CardForEntry } from "../link/rail.js";

export const PRIVACY_API = "https://api.privacy.com/v1";
export const PRIVACY_SANDBOX_API = "https://sandbox.privacy.com/v1";
export const UNUSED_CARD_TTL_MS = 24 * 60 * 60 * 1000;

export type PrivacySettings = {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  perPurchaseCapUsd: number;
  storeFile: string;
};

export function resolvePrivacySettings(cfg: BitterbotConfig): PrivacySettings {
  const p = cfg.payments?.privacy ?? {};
  return {
    enabled: p.enabled === true,
    apiKey: p.apiKey?.trim() || process.env.PRIVACY_API_KEY?.trim() || undefined,
    baseUrl: p.sandbox === true ? PRIVACY_SANDBOX_API : PRIVACY_API,
    perPurchaseCapUsd: p.perPurchaseCapUsd ?? 100,
    storeFile: path.join(os.homedir(), ".bitterbot", "payments", "privacy-cards.json"),
  };
}

export type PrivacyRequest = {
  id: string;
  cardToken: string;
  merchantName: string;
  merchantUrl: string;
  amountUsd: number;
  createdAt: number;
  closedAt?: number;
  filledAt?: number;
};

export type PrivacyRequestView = {
  id: string;
  status: "approved" | "used" | "closed";
  merchantName: string;
  amountUsd: number;
  card?: { last4?: string };
};

type FetchLike = typeof fetch;
type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});

function readStore(file: string): PrivacyRequest[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PrivacyRequest[]) : [];
  } catch {
    return [];
  }
}

function writeStore(file: string, list: PrivacyRequest[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class PrivacyRail {
  constructor(
    private readonly settings: PrivacySettings,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async api(method: string, pathname: string, body?: unknown): Promise<Raw> {
    if (!this.settings.apiKey) {
      throw new Error(
        "Privacy.com is not connected: set payments.privacy.apiKey (or PRIVACY_API_KEY) to an API key from privacy.com/account.",
      );
    }
    const res = await this.fetchImpl(`${this.settings.baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `api-key ${this.settings.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const data = obj(await res.json().catch(() => ({})));
    if (!res.ok) {
      // Never echo the response body wholesale: on some endpoints it holds the card.
      throw new Error(`Privacy.com refused (HTTP ${res.status}): ${str(data.message) ?? "error"}`);
    }
    return data;
  }

  async status(): Promise<{ connected: boolean; detail?: string }> {
    if (!this.settings.apiKey) {
      return { connected: false, detail: "no API key" };
    }
    try {
      await this.api("GET", "/cards?page_size=1");
      return { connected: true };
    } catch (err) {
      return { connected: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Create the single-use card for an approved purchase. Callers must have
   * the owner's approval already (the review queue runs this on approve).
   */
  async request(input: {
    merchantName: string;
    merchantUrl: string;
    amountUsd: number;
  }): Promise<PrivacyRequestView> {
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
    if (input.amountUsd > this.settings.perPurchaseCapUsd) {
      throw new Error(
        `$${input.amountUsd} is above the per-purchase limit of $${this.settings.perPurchaseCapUsd} (payments.privacy.perPurchaseCapUsd).`,
      );
    }
    const card = await this.api("POST", "/cards", {
      type: "SINGLE_USE",
      spend_limit: cents,
      spend_limit_duration: "TRANSACTION",
      memo: `Bitterbot: ${input.merchantName}`.slice(0, 100),
      state: "OPEN",
    });
    const token = str(card.token);
    if (!token) {
      throw new Error("Privacy.com created no card.");
    }
    const entry: PrivacyRequest = {
      id: `prq_${crypto.randomBytes(8).toString("hex")}`,
      cardToken: token,
      merchantName: input.merchantName,
      merchantUrl: url.toString(),
      amountUsd: cents / 100,
      createdAt: this.now(),
    };
    writeStore(this.settings.storeFile, [...readStore(this.settings.storeFile), entry]);
    return this.view(entry, str(card.last_four));
  }

  private view(r: PrivacyRequest, last4?: string): PrivacyRequestView {
    return {
      id: r.id,
      status: r.closedAt ? "closed" : r.filledAt ? "used" : "approved",
      merchantName: r.merchantName,
      amountUsd: r.amountUsd,
      ...(last4 ? { card: { last4 } } : {}),
    };
  }

  async check(id: string): Promise<PrivacyRequestView> {
    await this.closeStale();
    const r = readStore(this.settings.storeFile).find((x) => x.id === id);
    if (!r) {
      throw new Error(
        `No Privacy purchase ${id}. It is created only after the owner approves the request.`,
      );
    }
    return this.view(r);
  }

  /** Read the card for typing into a checkout page. Never return it to the model. */
  async takeCard(id: string): Promise<CardForEntry> {
    const list = readStore(this.settings.storeFile);
    const r = list.find((x) => x.id === id);
    if (!r || r.closedAt) {
      throw new Error(`Privacy purchase ${id} is not open.`);
    }
    const card = await this.api("GET", `/cards/${encodeURIComponent(r.cardToken)}`);
    const number = str(card.pan)?.replace(/\s+/g, "");
    const expMonth = Number(str(card.exp_month));
    const expYear = Number(str(card.exp_year));
    if (
      !number ||
      !Number.isFinite(expMonth) ||
      !Number.isFinite(expYear) ||
      str(card.state) !== "OPEN"
    ) {
      throw new Error("Privacy.com returned no open card for this purchase.");
    }
    r.filledAt = this.now();
    writeStore(this.settings.storeFile, list);
    return {
      number,
      cvc: str(card.cvv),
      expMonth,
      expYear,
      brand: "Privacy card",
      last4: number.slice(-4),
    };
  }

  /** Close cards that were approved but not used within a day. */
  async closeStale(): Promise<number> {
    const list = readStore(this.settings.storeFile);
    const at = this.now();
    let closed = 0;
    for (const r of list) {
      if (!r.closedAt && !r.filledAt && at - r.createdAt > UNUSED_CARD_TTL_MS) {
        try {
          await this.api("PATCH", `/cards/${encodeURIComponent(r.cardToken)}`, { state: "CLOSED" });
          r.closedAt = at;
          closed++;
        } catch {
          // Try again next time.
        }
      }
    }
    if (closed > 0) {
      writeStore(this.settings.storeFile, list);
    }
    return closed;
  }
}
