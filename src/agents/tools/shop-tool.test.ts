import { beforeEach, describe, expect, it, vi } from "vitest";

const callStore = vi.fn();
// A plain function, not the spy, raises the store error: in this suite a
// rejection from the spy failed the test even though the tool caught it.
let failWith: Error | null = null;
vi.mock("../../shop/ucp.js", async (orig) => ({
  ...(await orig<typeof import("../../shop/ucp.js")>()),
  callStore: async (...args: unknown[]) => {
    if (failWith) {
      throw failWith;
    }
    return callStore(...args);
  },
}));

const { createShopTool } = await import("./shop-tool.js");
const { ShopError } = await import("../../shop/ucp.js");

beforeEach(() => {
  callStore.mockReset();
  failWith = null;
});

describe("shop tool", () => {
  it("is off when shop.enabled is false", () => {
    expect(createShopTool({ config: { shop: { enabled: false } } })).toBeNull();
  });

  it("creates a cart from variant ids and returns the checkout link", async () => {
    callStore.mockResolvedValue({
      id: "gid://shopify/Cart/1",
      currency: "USD",
      line_items: [{ quantity: 2, item: { id: "v1", title: "Tee - M", price: 2500 } }],
      totals: [{ type: "total", amount: 5000 }],
      continue_url: "https://s.com/cart/c/1",
    });
    const res = await createShopTool()!.execute("1", {
      action: "cart",
      store: "s.com",
      items: [{ variantId: "v1", quantity: 2 }],
      country: "us",
    });
    expect(callStore).toHaveBeenCalledWith(
      "s.com",
      "create_cart",
      {
        cart: {
          line_items: [{ item: { id: "v1" }, quantity: 2 }],
          context: { address_country: "US" },
        },
      },
      expect.any(Object),
    );
    expect(res.details).toMatchObject({
      cart: { total: "$50.00", continueUrl: "https://s.com/cart/c/1" },
    });
  });

  it("replaces an existing cart's contents when given its id", async () => {
    callStore.mockResolvedValue({ id: "c", line_items: [] });
    await createShopTool()!.execute("2", {
      action: "cart",
      store: "s.com",
      cartId: "c",
      items: [{ variantId: "v2", quantity: 1 }],
    });
    expect(callStore.mock.calls[0]?.[1]).toBe("update_cart");
    expect(callStore.mock.calls[0]?.[2]).toMatchObject({ id: "c" });
  });

  it("returns a store's refusal as a plain answer with its link", async () => {
    failWith = new ShopError("The store refused: busy", "https://s.com/");
    const res = await createShopTool()!.execute("3", {
      action: "search",
      store: "s.com",
      query: "x",
    });
    expect(res.details).toEqual({
      ok: false,
      error: "The store refused: busy",
      continueUrl: "https://s.com/",
    });
  });
});
