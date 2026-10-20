/**
 * The `shop` tool (PLAN-53 C3): find products on a store that supports agent
 * shopping (Shopify's Universal Commerce Protocol), build a cart, and give the
 * owner the link to pay on the merchant's own checkout. The agent never
 * completes a purchase here.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import {
  callStore,
  ShopError,
  summarizeCart,
  summarizeProduct,
  type ShopClientOptions,
} from "../../shop/ucp.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const SHOP_ACTIONS = ["search", "product", "cart", "view_cart"] as const;

const ShopToolSchema = Type.Object({
  action: stringEnum(SHOP_ACTIONS, {
    description:
      "search (store + query) | product (store + productId, for all variants) | cart (store + items; pass cartId to replace an existing cart's contents) | view_cart (store + cartId)",
  }),
  store: Type.String({ description: "The shop's domain, e.g. allbirds.com." }),
  query: Type.Optional(Type.String({ description: "For search: what to look for." })),
  maxResults: Type.Optional(
    Type.Number({ description: "For search: at most this many products (default 5, max 10)." }),
  ),
  productId: Type.Optional(
    Type.String({ description: "For product: the product id from search." }),
  ),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        variantId: Type.String({ description: "A variant id from search or product." }),
        quantity: Type.Number({ description: "How many." }),
      }),
      {
        description:
          "For cart: the full cart contents. On an existing cart this REPLACES everything, so include the items to keep.",
      },
    ),
  ),
  cartId: Type.Optional(Type.String({ description: "For cart (update) and view_cart." })),
  country: Type.Optional(
    Type.String({ description: "Buyer's country (ISO 3166-1 alpha-2) for local prices." }),
  ),
});

export function createShopTool(opts: { config?: BitterbotConfig } = {}): AnyAgentTool | null {
  const cfg = opts.config?.shop;
  if (cfg?.enabled === false) {
    return null;
  }
  const client: ShopClientOptions = { profileUrl: cfg?.ucpProfileUrl };
  return {
    label: "Shop",
    name: "shop",
    description: [
      "Shop on stores that support agent shopping (most Shopify stores): search products, read variants (size, color) and prices, and build a cart.",
      "The result of `cart` includes `continueUrl`: send that link to the user so they can review and pay on the store's own checkout. You cannot pay from here.",
      "Prices are already converted to normal currency. Confirm size and color with the user before building the cart.",
      "If a store does not support agent shopping, say so and share the product page instead.",
    ].join(" "),
    parameters: ShopToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const store = readStringParam(params, "store", { required: true });
      const country = readStringParam(params, "country");
      const context = country ? { context: { address_country: country.toUpperCase() } } : {};
      try {
        switch (action) {
          case "search": {
            const query = readStringParam(params, "query", { required: true });
            const max = Math.min(Math.max(readNumberParam(params, "maxResults") ?? 5, 1), 10);
            const res = await callStore(
              store,
              "search_catalog",
              { catalog: { query, ...context } },
              client,
            );
            const products = Array.isArray(res.products) ? res.products : [];
            return jsonResult({
              store,
              products: products
                .slice(0, max)
                .map((p) => summarizeProduct(p as Record<string, unknown>, 6)),
            });
          }
          case "product": {
            const id = readStringParam(params, "productId", { required: true });
            const res = await callStore(
              store,
              "get_product",
              { catalog: { id, ...context } },
              client,
            );
            const product = (res.product ?? res) as Record<string, unknown>;
            return jsonResult({ store, product: summarizeProduct(product, 50) });
          }
          case "cart": {
            const raw = Array.isArray(params.items) ? params.items : [];
            const lineItems = raw
              .map((i) => i as { variantId?: unknown; quantity?: unknown })
              .filter((i) => typeof i.variantId === "string" && typeof i.quantity === "number")
              .map((i) => ({
                item: { id: String(i.variantId) },
                quantity: Math.max(1, Math.floor(Number(i.quantity))),
              }));
            if (lineItems.length === 0) {
              throw new ShopError("cart needs items: [{variantId, quantity}].");
            }
            const cartId = readStringParam(params, "cartId");
            const cart = { line_items: lineItems, ...context };
            const res = cartId
              ? await callStore(store, "update_cart", { id: cartId, cart }, client)
              : await callStore(store, "create_cart", { cart }, client);
            return jsonResult({ store, cart: summarizeCart(res) });
          }
          case "view_cart": {
            const cartId = readStringParam(params, "cartId", { required: true });
            const res = await callStore(store, "get_cart", { id: cartId }, client);
            return jsonResult({ store, cart: summarizeCart(res) });
          }
          default:
            throw new ShopError(`Unknown action "${action}".`);
        }
      } catch (err) {
        // By name: the class can differ across bundle boundaries.
        if (err instanceof ShopError || (err instanceof Error && err.name === "ShopError")) {
          const continueUrl = (err as ShopError).continueUrl;
          return jsonResult({
            ok: false,
            error: err.message,
            ...(continueUrl ? { continueUrl } : {}),
          });
        }
        throw err;
      }
    },
  };
}
