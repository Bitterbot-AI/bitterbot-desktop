/**
 * Shopping on Shopify stores through the Universal Commerce Protocol
 * (PLAN-53 C3). A store publishes `/.well-known/ucp`; its MCP endpoint serves
 * catalog search, product lookup and carts to anonymous agents that name a
 * public agent profile. The agent builds the cart; the owner pays on the
 * merchant's own checkout through the cart's `continue_url`. Nothing here
 * completes a checkout, so no money moves.
 */

import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

export const UCP_VERSION = "2026-08-25";

/** The published Bitterbot agent profile (repo file `ucp/agent-profile.json`). */
export const DEFAULT_UCP_PROFILE_URL =
  "https://cdn.jsdelivr.net/gh/Bitterbot-AI/bitterbot-desktop@main/ucp/agent-profile.json";

export class ShopError extends Error {
  constructor(
    message: string,
    readonly continueUrl?: string,
  ) {
    super(message);
    this.name = "ShopError";
  }
}

export type FetchLike = typeof fetch;

export type ShopClientOptions = {
  profileUrl?: string;
  /** Tests only: bypasses the SSRF guard. */
  fetchImpl?: FetchLike;
};

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** "allbirds.com", "https://www.allbirds.com/products/x" → "https://www.allbirds.com". */
export function normalizeStore(input: string): string {
  const raw = input.trim();
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    throw new ShopError(
      `"${input}" is not a store address. Use the shop's domain, e.g. allbirds.com.`,
    );
  }
  if (!HOST_RE.test(host)) {
    throw new ShopError(
      `"${input}" is not a store address. Use the shop's domain, e.g. allbirds.com.`,
    );
  }
  return `https://${host}`;
}

/** A store's MCP endpoint may live on its own host or on its myshopify.com host. */
export function endpointAllowed(storeOrigin: string, endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const store = new URL(storeOrigin).hostname.toLowerCase();
  const bare = (h: string) => h.replace(/^www\./, "");
  return bare(host) === bare(store) || /^[a-z0-9-]+\.myshopify\.com$/.test(host);
}

async function fetchJson(
  url: string,
  init: RequestInit,
  opts: ShopClientOptions,
): Promise<{ status: number; body: unknown }> {
  if (opts.fetchImpl) {
    const res = await opts.fetchImpl(url, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guarded = await fetchWithSsrFGuard({
      url,
      init,
      // Discovery may hop www/apex; a POST to the advertised endpoint never redirects.
      maxRedirects: init.method === "POST" ? 0 : 3,
      timeoutMs: 20_000,
      auditContext: "shop",
    });
  } catch (err) {
    const host = new URL(url).hostname;
    throw new ShopError(
      err instanceof SsrFBlockedError
        ? `${host} is not a public store address.`
        : `Could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { response, release } = guarded;
  try {
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await release();
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const endpointCache = new Map<string, { endpoint: string; at: number }>();
const ENDPOINT_TTL_MS = 60 * 60 * 1000;

/** Find the store's UCP MCP endpoint from its discovery document. */
export async function discoverEndpoint(
  store: string,
  opts: ShopClientOptions = {},
): Promise<string> {
  const origin = normalizeStore(store);
  const cached = endpointCache.get(origin);
  if (cached && Date.now() - cached.at < ENDPOINT_TTL_MS) {
    return cached.endpoint;
  }
  const { status, body } = await fetchJson(
    `${origin}/.well-known/ucp`,
    { headers: { Accept: "application/json" } },
    opts,
  );
  const services = isRecord(body) && isRecord(body.ucp) ? body.ucp.services : undefined;
  const shopping = isRecord(services) ? services["dev.ucp.shopping"] : undefined;
  const mcp = Array.isArray(shopping)
    ? shopping.find((s) => isRecord(s) && s.transport === "mcp" && typeof s.endpoint === "string")
    : undefined;
  if (status !== 200 || !isRecord(mcp)) {
    throw new ShopError(
      `${new URL(origin).hostname} does not offer agent shopping (no UCP endpoint). Send the owner the store's link instead.`,
    );
  }
  const endpoint = String(mcp.endpoint);
  if (!endpointAllowed(origin, endpoint)) {
    throw new ShopError(
      `${new URL(origin).hostname} points its shopping endpoint somewhere else; not using it.`,
    );
  }
  endpointCache.set(origin, { endpoint, at: Date.now() });
  return endpoint;
}

let rpcId = 0;

/** Call one UCP tool on a store and return its structured result. */
export async function callStore(
  store: string,
  tool: string,
  args: Record<string, unknown>,
  opts: ShopClientOptions = {},
): Promise<Record<string, unknown>> {
  const endpoint = await discoverEndpoint(store, opts);
  const { status, body } = await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: {
          name: tool,
          arguments: {
            meta: { "ucp-agent": { profile: opts.profileUrl ?? DEFAULT_UCP_PROFILE_URL } },
            ...args,
          },
        },
      }),
    },
    opts,
  );
  if (!isRecord(body)) {
    throw new ShopError(`The store answered with HTTP ${status} and no data.`);
  }
  if (isRecord(body.error)) {
    const data = isRecord(body.error.data) ? body.error.data : {};
    const detail =
      typeof data.content === "string"
        ? data.content
        : typeof body.error.data === "string"
          ? body.error.data
          : "";
    throw new ShopError(
      `The store refused: ${String(body.error.message ?? "error")}${detail ? ` (${detail})` : ""}`,
      typeof data.continue_url === "string" ? data.continue_url : undefined,
    );
  }
  const result = isRecord(body.result) ? body.result : {};
  if (isRecord(result.structuredContent)) {
    return result.structuredContent;
  }
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (isRecord(first) && typeof first.text === "string") {
    try {
      const parsed = JSON.parse(first.text) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      throw new ShopError(`The store said: ${first.text.slice(0, 300)}`);
    }
  }
  throw new ShopError("The store's answer had no result.");
}

// ── Shaping results for the model ───────────────────────────────────────────

/** UCP prices are integers in minor units: {amount: 11000, currency: "USD"} is $110.00. */
export function formatMoney(amount: unknown, currency: unknown): string | null {
  if (typeof amount !== "number" || typeof currency !== "string") {
    return null;
  }
  try {
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(amount / 10 ** digits);
  } catch {
    return `${amount} ${currency} (minor units)`;
  }
}

const money = (m: unknown) => (isRecord(m) ? formatMoney(m.amount, m.currency) : null);

export type ProductSummary = {
  id: string;
  title: string;
  url: string | null;
  price: string | null;
  variants: Array<{ id: string; title: string; price: string | null; available: boolean | null }>;
};

export function summarizeProduct(p: Record<string, unknown>, maxVariants = 12): ProductSummary {
  const range = isRecord(p.price_range) ? p.price_range : {};
  const lo = money(range.min);
  const hi = money(range.max);
  const variants = Array.isArray(p.variants) ? p.variants.filter(isRecord) : [];
  return {
    id: String(p.id ?? ""),
    title: String(p.title ?? ""),
    url: typeof p.url === "string" ? p.url : null,
    price: lo && hi && lo !== hi ? `${lo} to ${hi}` : lo,
    variants: variants.slice(0, maxVariants).map((v) => ({
      id: String(v.id ?? ""),
      title: String(v.title ?? ""),
      price: money(v.price),
      available:
        isRecord(v.availability) && typeof v.availability.available === "boolean"
          ? v.availability.available
          : null,
    })),
  };
}

export type CartSummary = {
  cartId: string;
  items: Array<{ variantId: string; title: string; quantity: number; price: string | null }>;
  total: string | null;
  continueUrl: string | null;
  expiresAt: string | null;
  notes: string[];
};

export function summarizeCart(c: Record<string, unknown>): CartSummary {
  const currency = c.currency;
  const lines = Array.isArray(c.line_items) ? c.line_items.filter(isRecord) : [];
  const totals = Array.isArray(c.totals) ? c.totals.filter(isRecord) : [];
  const total = totals.find((t) => t.type === "total") ?? totals.find((t) => t.type === "subtotal");
  const messages = Array.isArray(c.messages) ? c.messages.filter(isRecord) : [];
  return {
    cartId: String(c.id ?? ""),
    items: lines.map((l) => {
      const item = isRecord(l.item) ? l.item : {};
      return {
        variantId: String(item.id ?? ""),
        title: String(item.title ?? ""),
        quantity: typeof l.quantity === "number" ? l.quantity : 0,
        price: formatMoney(item.price, currency),
      };
    }),
    total: total ? formatMoney(total.amount, currency) : null,
    continueUrl: typeof c.continue_url === "string" ? c.continue_url : null,
    expiresAt: typeof c.expires_at === "string" ? c.expires_at : null,
    notes: messages
      .map((m) =>
        typeof m.content === "string" ? m.content : typeof m.code === "string" ? m.code : "",
      )
      .filter(Boolean),
  };
}
