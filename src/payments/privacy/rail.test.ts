import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRIVACY_API,
  PrivacyRail,
  type PrivacySettings,
  siteOf,
  UNUSED_CARD_TTL_MS,
} from "./rail.js";

let dir: string;
let settings: PrivacySettings;
let clock: number;
type Call = { method: string; url: string; body?: Record<string, unknown>; auth?: string };
let calls: Call[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakePrivacy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  calls.push({
    method,
    url,
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined,
    auth: headers.get("authorization") ?? undefined,
  });
  if (method === "POST") {
    return json({ token: "card-1", last_four: "4242", state: "OPEN" });
  }
  if (method === "GET" && url.endsWith("/cards/card-1")) {
    return json({
      token: "card-1",
      pan: "4111111111114242",
      cvv: "123",
      exp_month: "09",
      exp_year: "2030",
      state: "OPEN",
    });
  }
  return json({ data: [] });
}) as unknown as typeof fetch;

const rail = () => new PrivacyRail(settings, fakePrivacy, () => clock);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-privacy-"));
  settings = {
    enabled: true,
    apiKey: "pk_test",
    baseUrl: PRIVACY_API,
    perPurchaseCapUsd: 100,
    storeFile: path.join(dir, "privacy-cards.json"),
  };
  clock = 1_700_000_000_000;
  calls = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Privacy rail", () => {
  it("creates one single-use card capped at the approved amount and keeps only its token", async () => {
    const view = await rail().request({
      merchantName: "Shop",
      merchantUrl: "https://shop.com/cart",
      amountUsd: 42.5,
    });

    expect(view).toMatchObject({
      status: "approved",
      merchantName: "Shop",
      amountUsd: 42.5,
      card: { last4: "4242" },
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${PRIVACY_API}/cards`,
      auth: "api-key pk_test",
      body: { type: "SINGLE_USE", spend_limit: 4250, spend_limit_duration: "TRANSACTION" },
    });
    const stored = fs.readFileSync(settings.storeFile, "utf8");
    expect(stored).toContain("card-1");
    expect(stored).not.toContain("4111");
  });

  it("refuses amounts over the cap, non-https merchants, and a missing key", async () => {
    await expect(
      rail().request({ merchantName: "S", merchantUrl: "https://s.com", amountUsd: 101 }),
    ).rejects.toThrow(/per-purchase limit/);
    await expect(
      rail().request({ merchantName: "S", merchantUrl: "http://s.com", amountUsd: 5 }),
    ).rejects.toThrow(/https/);
    settings.apiKey = undefined;
    await expect(
      rail().request({ merchantName: "S", merchantUrl: "https://s.com", amountUsd: 5 }),
    ).rejects.toThrow(/not connected/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("hands the card over once for typing, then reports it used", async () => {
    const r = rail();
    const { id } = await r.request({
      merchantName: "Shop",
      merchantUrl: "https://shop.com",
      amountUsd: 10,
    });
    const card = await r.takeCard(id);
    expect(card).toMatchObject({
      number: "4111111111114242",
      cvc: "123",
      expMonth: 9,
      expYear: 2030,
      last4: "4242",
    });
    expect((await r.check(id)).status).toBe("used");
  });

  it("closes a card nobody used within a day", async () => {
    const r = rail();
    const { id } = await r.request({
      merchantName: "Shop",
      merchantUrl: "https://shop.com",
      amountUsd: 10,
    });
    clock += UNUSED_CARD_TTL_MS + 1;
    expect((await r.check(id)).status).toBe("closed");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: `${PRIVACY_API}/cards/card-1`,
      body: { state: "CLOSED" },
    });
    await expect(r.takeCard(id)).rejects.toThrow(/not open/);
  });

  it("hands a card over at most once, even to two fills at the same time", async () => {
    const r = rail();
    const { id } = await r.request({
      merchantName: "Shop",
      merchantUrl: "https://shop.com",
      amountUsd: 10,
    });
    const results = await Promise.allSettled([r.takeCard(id), r.takeCard(id)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("names the site a host belongs to", () => {
    expect(siteOf("checkout.shop.com")).toBe("shop.com");
    expect(siteOf("www.shop.co.uk")).toBe("shop.co.uk");
    expect(siteOf("shop.com")).toBe("shop.com");
  });
});
