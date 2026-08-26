/**
 * PLAN-39 Phase 3: where the renderer's gateway lives, and how it gets a token.
 *
 * Replaces two build-time mechanisms: the `VITE_GATEWAY_TOKEN` define (which
 * baked the gateway credential into the JS bundle, PLAN-37 item 13) and the
 * absolute `VITE_GATEWAY_URL` default. Both made the built artifact
 * machine-specific; neither survives being served to a browser.
 */

const LS_TOKEN_KEY = "bitterbot-gateway-token";
const LS_URL_KEY = "bitterbot-gateway-url";

/** Path of the gateway's same-origin token handoff endpoint. */
export const SESSION_TOKEN_PATH = "/auth/session-token";

const readLocalStorage = (key: string): string | null => {
  try {
    const value = localStorage.getItem(key);
    return value && value.trim() ? value.trim() : null;
  } catch {
    // Unavailable in non-browser contexts and restrictive private modes.
    return null;
  }
};

/** True when the page was served over http(s), as opposed to file:// or tauri://. */
const hasHttpOrigin = (loc: Location | undefined): loc is Location =>
  Boolean(loc && (loc.protocol === "http:" || loc.protocol === "https:") && loc.host);

/**
 * Resolve the gateway WebSocket URL.
 *
 * Precedence is the specification, not an implementation detail:
 *
 *   1. localStorage override, for a remote gateway entered via FirstRun.
 *   2. `VITE_GATEWAY_URL`, but ONLY in a dev build. This branch must sit above
 *      derivation: under `pnpm dev:all` the page origin is the Vite dev server
 *      (5173), which is a perfectly real origin, so deriving from it would yield
 *      a URL where no gateway listens and the fallback would never be reached.
 *   3. Derived from `window.location`, which is correct whenever the gateway
 *      served the page: same host, same port, ws(s) matching http(s).
 *   4. Hardcoded loopback, for tauri:// and file:// origins.
 */
export function resolveGatewayWsUrl(opts?: { location?: Location; isDev?: boolean }): string {
  const stored = readLocalStorage(LS_URL_KEY);
  if (stored) {
    return stored;
  }

  const isDev = opts?.isDev ?? import.meta.env.DEV;
  const configured = import.meta.env.VITE_GATEWAY_URL;
  if (isDev && typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }

  const loc = opts?.location ?? (typeof window === "undefined" ? undefined : window.location);
  if (hasHttpOrigin(loc)) {
    return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}`;
  }

  return "ws://127.0.0.1:19001";
}

/** HTTP origin of the gateway, derived from the same precedence as the WS URL. */
export function resolveGatewayHttpOrigin(opts?: { location?: Location; isDev?: boolean }): string {
  const ws = resolveGatewayWsUrl(opts);
  return ws.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

/** A token the user previously entered, if any. */
export function readStoredGatewayToken(): string | null {
  return readLocalStorage(LS_TOKEN_KEY);
}

/**
 * Ask the gateway that served this page for its token.
 *
 * Only meaningful same-origin: the gateway answers this on loopback with a
 * matching Host header and refuses everything else, so a cross-origin dev build
 * or a remote gateway simply gets null and falls through to FirstRun.
 *
 * Returns null on any failure, including a 403, a non-JSON body, or a gateway
 * with no auth configured.
 */
export async function fetchSessionToken(opts?: {
  origin?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string | null> {
  const origin = opts?.origin ?? resolveGatewayHttpOrigin();
  const doFetch = opts?.fetchImpl ?? (typeof fetch === "undefined" ? undefined : fetch);
  if (!doFetch) {
    return null;
  }
  try {
    const res = await doFetch(`${origin}${SESSION_TOKEN_PATH}`, {
      credentials: "omit",
      signal: opts?.signal,
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token.trim() ? body.token.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The bootstrap sequence: a previously entered token, else the same-origin
 * handoff. Null means FirstRun should ask the user.
 */
export async function resolveGatewayToken(opts?: {
  origin?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  return readStoredGatewayToken() ?? (await fetchSessionToken(opts));
}

export function persistGatewayCredentials(params: { url: string; token: string }): void {
  try {
    localStorage.setItem(LS_URL_KEY, params.url);
    localStorage.setItem(LS_TOKEN_KEY, params.token);
  } catch {
    // Nothing to do: the session still works, it just will not be remembered.
  }
}

export { LS_TOKEN_KEY, LS_URL_KEY };
