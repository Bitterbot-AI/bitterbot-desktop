import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";
import { summarizeX402Offer } from "./web-fetch.js";
import { createWebFetchTool } from "./web-tools.js";

vi.mock("./web-fetch-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./web-fetch-utils.js")>("./web-fetch-utils.js");
  return { ...actual, extractReadableContent: vi.fn() };
});

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const lookupMock = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const baseToolConfig = {
  config: { tools: { web: { fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } } } } },
} as const;

function paymentRequiredHeader(accepts: Array<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
}

describe("summarizeX402Offer", () => {
  it("prices a USDC offer from atomic units without float rounding", () => {
    expect(
      summarizeX402Offer({
        accepts: [{ amount: "10000", asset: USDC_BASE, network: "eip155:8453" }],
      }),
    ).toEqual({
      offer: { amount: "10000", asset: USDC_BASE, network: "eip155:8453" },
      priceUsdc: "0.01",
    });
    expect(
      summarizeX402Offer({ accepts: [{ amount: "1234567", asset: USDC_BASE }] })?.priceUsdc,
    ).toBe("1.234567");
    expect(
      summarizeX402Offer({ accepts: [{ amount: "3000000", asset: USDC_BASE }] })?.priceUsdc,
    ).toBe("3");
  });

  it("accepts the v1 maxAmountRequired name and a lower-case asset", () => {
    const summary = summarizeX402Offer({
      accepts: [{ maxAmountRequired: "150000", asset: USDC_BASE.toLowerCase() }],
    });
    expect(summary?.priceUsdc).toBe("0.15");
  });

  it("surfaces a non-USDC offer raw and never labels it as dollars", () => {
    const summary = summarizeX402Offer({
      accepts: [
        {
          amount: "10000",
          asset: "0x4200000000000000000000000000000000000006",
          network: "eip155:8453",
        },
      ],
    });
    expect(summary?.offer.amount).toBe("10000");
    expect(summary?.priceUsdc).toBeUndefined();
    expect(summarizeX402Offer({ accepts: [{ amount: "10000" }] })?.priceUsdc).toBeUndefined();
  });

  it("skips unpriced entries and tolerates garbage", () => {
    expect(summarizeX402Offer({ accepts: [{ amount: "1e6" }, { amount: "-5" }] })).toBeUndefined();
    expect(summarizeX402Offer({ accepts: "nope" })).toBeUndefined();
    expect(summarizeX402Offer(undefined)).toBeUndefined();
    expect(
      summarizeX402Offer({ accepts: [null, { amount: "abc" }, { amount: "7", asset: USDC_BASE }] })
        ?.priceUsdc,
    ).toBe("0.000007");
  });
});

describe("web_fetch x402 v2 402 responses", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  afterEach(() => {
    // @ts-expect-error restore
    global.fetch = priorFetch;
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it("decodes the PAYMENT-REQUIRED header and reports price_usdc", async () => {
    const response = new Response("Payment required", {
      status: 402,
      headers: {
        "content-type": "text/plain",
        "payment-required": paymentRequiredHeader([
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "10000",
            asset: USDC_BASE,
            payTo: "0xabc",
          },
        ]),
      },
    });
    // @ts-expect-error mock fetch
    global.fetch = vi.fn().mockResolvedValue(response);

    const tool = createWebFetchTool(baseToolConfig);
    const result = await tool?.execute?.("call", { url: "https://example.com/paid" });
    const details = result?.details as Record<string, unknown>;

    expect(details.status).toBe(402);
    expect(details.price_usdc).toBe("0.01");
    expect(details.x402_offer).toEqual({
      amount: "10000",
      asset: USDC_BASE,
      network: "eip155:8453",
      scheme: "exact",
      payTo: "0xabc",
    });
    expect((details.payment_required as { x402Version: number }).x402Version).toBe(2);
    expect((details.x402_headers as Record<string, string>)["x-payment-amount"]).toBe("");
  });

  it("ignores a malformed header and keeps the legacy fields", async () => {
    const response = new Response(
      JSON.stringify({ accepts: [{ maxAmountRequired: "250000", asset: USDC_BASE }] }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          "payment-required": "%%not-base64-json%%",
          "x-payment-amount": "0.25",
        },
      },
    );
    // @ts-expect-error mock fetch
    global.fetch = vi.fn().mockResolvedValue(response);

    const tool = createWebFetchTool(baseToolConfig);
    const result = await tool?.execute?.("call", { url: "https://example.com/paid" });
    const details = result?.details as Record<string, unknown>;

    expect(details.payment_required).toBeUndefined();
    expect(details.price_usdc).toBe("0.25");
    expect((details.x402_headers as Record<string, string>)["x-payment-amount"]).toBe("0.25");
  });
});
