import { describe, expect, it, vi } from "vitest";
import {
  callStore,
  discoverEndpoint,
  endpointAllowed,
  formatMoney,
  normalizeStore,
  ShopError,
  summarizeCart,
  summarizeProduct,
} from "./ucp.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const discovery = (endpoint: string) => ({
  ucp: { services: { "dev.ucp.shopping": [{ transport: "mcp", endpoint }] } },
});

describe("store addresses", () => {
  it("accepts a domain or a product link and refuses anything else", () => {
    expect(normalizeStore("Allbirds.com")).toBe("https://allbirds.com");
    expect(normalizeStore("https://www.allbirds.com/products/x?y=1")).toBe(
      "https://www.allbirds.com",
    );
    expect(() => normalizeStore("localhost")).toThrow(ShopError);
    expect(() => normalizeStore("not a store")).toThrow(ShopError);
  });

  it("uses only an endpoint on the store itself or its myshopify.com host", () => {
    expect(endpointAllowed("https://www.allbirds.com", "https://allbirds.com/api/ucp/mcp")).toBe(
      true,
    );
    expect(
      endpointAllowed("https://allbirds.com", "https://weareallbirds.myshopify.com/api/ucp/mcp"),
    ).toBe(true);
    expect(endpointAllowed("https://allbirds.com", "https://evil.example/api/ucp/mcp")).toBe(false);
    expect(endpointAllowed("https://allbirds.com", "http://allbirds.com/api/ucp/mcp")).toBe(false);
  });
});

describe("calling a store", () => {
  it("discovers the endpoint, names the agent profile, and returns structured content", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).endsWith("/.well-known/ucp")) {
        return json(discovery("https://shop-a.myshopify.com/api/ucp/mcp"));
      }
      return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { products: [] } } });
    }) as unknown as typeof fetch;

    const res = await callStore(
      "shop-a.com",
      "search_catalog",
      { catalog: { query: "x" } },
      {
        fetchImpl,
        profileUrl: "https://example.com/profile.json",
      },
    );

    expect(res).toEqual({ products: [] });
    expect(calls[1]?.url).toBe("https://shop-a.myshopify.com/api/ucp/mcp");
    expect(calls[1]?.body).toMatchObject({
      method: "tools/call",
      params: {
        name: "search_catalog",
        arguments: {
          meta: { "ucp-agent": { profile: "https://example.com/profile.json" } },
          catalog: { query: "x" },
        },
      },
    });
  });

  it("explains a store without agent shopping, and refuses an endpoint elsewhere", async () => {
    const none = vi.fn(async () => json({}, 404)) as unknown as typeof fetch;
    await expect(discoverEndpoint("no-ucp.com", { fetchImpl: none })).rejects.toThrow(
      /does not offer agent shopping/,
    );
    const elsewhere = vi.fn(async () =>
      json(discovery("https://evil.example/mcp")),
    ) as unknown as typeof fetch;
    await expect(discoverEndpoint("shop-b.com", { fetchImpl: elsewhere })).rejects.toThrow(
      /somewhere else/,
    );
  });

  it("passes the store's refusal and its continue_url through", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/.well-known/ucp")
        ? json(discovery("https://shop-c.com/api/ucp/mcp"))
        : json({
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32001,
              message: "UCP discovery failed",
              data: { content: "bad profile", continue_url: "https://shop-c.com/" },
            },
          }),
    ) as unknown as typeof fetch;
    const err = await callStore("shop-c.com", "get_cart", { id: "x" }, { fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ShopError);
    expect((err as ShopError).message).toContain("bad profile");
    expect((err as ShopError).continueUrl).toBe("https://shop-c.com/");
  });
});

describe("shaping results", () => {
  it("converts minor units to money", () => {
    expect(formatMoney(11000, "USD")).toBe("$110.00");
    expect(formatMoney(1500, "JPY")).toBe("¥1,500");
    expect(formatMoney("x", "USD")).toBeNull();
  });

  it("summarizes a product and a cart", () => {
    const product = summarizeProduct({
      id: "gid://shopify/Product/1",
      title: "Wool Runner",
      url: "https://s.com/products/wr",
      price_range: {
        min: { amount: 11000, currency: "USD" },
        max: { amount: 12000, currency: "USD" },
      },
      variants: [
        {
          id: "v1",
          title: "9",
          price: { amount: 11000, currency: "USD" },
          availability: { available: true },
        },
      ],
    });
    expect(product).toEqual({
      id: "gid://shopify/Product/1",
      title: "Wool Runner",
      url: "https://s.com/products/wr",
      price: "$110.00 to $120.00",
      variants: [{ id: "v1", title: "9", price: "$110.00", available: true }],
    });
    const cart = summarizeCart({
      id: "gid://shopify/Cart/abc",
      currency: "USD",
      line_items: [{ quantity: 1, item: { id: "v1", title: "Wool Runner - 9", price: 11000 } }],
      totals: [
        { type: "subtotal", amount: 11000 },
        { type: "total", amount: 11000 },
      ],
      continue_url: "https://s.com/cart/c/abc",
      messages: [],
    });
    expect(cart).toMatchObject({
      cartId: "gid://shopify/Cart/abc",
      items: [{ variantId: "v1", title: "Wool Runner - 9", quantity: 1, price: "$110.00" }],
      total: "$110.00",
      continueUrl: "https://s.com/cart/c/abc",
    });
  });
});
