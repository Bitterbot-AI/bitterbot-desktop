/**
 * The `/setup` route (PLAN-56 Phase 4): browser-first onboarding.
 *
 * The gateway serves the same bundle at `<basePath>/setup`; the app renders the
 * setup page instead of the dashboard there. `bitterbot onboard` opens
 * `http://127.0.0.1:<port><basePath>/setup?token=<setup token>`.
 *
 * The token is taken out of the address bar at once (history.replaceState)
 * so it does not linger in history or leak through a Referer, and is kept in
 * sessionStorage only so a reload of the same tab keeps working.
 */

export const SETUP_PATH_SUFFIX = "/setup";
const SESSION_KEY = "bitterbot-setup-token";

/** True when the page is the setup route (any base path). */
export function isSetupPath(pathname: string): boolean {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === SETUP_PATH_SUFFIX || trimmed.endsWith(SETUP_PATH_SUFFIX);
}

/** The Control UI base path the gateway mounted the bundle under ("" at /). */
export function setupBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed.endsWith(SETUP_PATH_SUFFIX) ? trimmed.slice(0, -SETUP_PATH_SUFFIX.length) : "";
}

function readSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSession(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(SESSION_KEY, token);
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // The setup still works for this page load.
  }
}

/**
 * Read the setup token from `?token=` (then remove it from the URL), or from
 * this tab's earlier load. Null means "no setup link": the page signs in the
 * normal Control UI way (admin) instead.
 */
export function takeSetupToken(loc: Location = window.location, hist: History = window.history) {
  const url = new URL(loc.href);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) {
    writeSession(fromQuery);
    url.searchParams.delete("token");
    try {
      hist.replaceState(hist.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Not fatal: the token dies when setup finishes and is short-lived anyway.
    }
    return fromQuery;
  }
  return readSession();
}

export function forgetSetupToken(): void {
  writeSession(null);
}

/** The gateway WebSocket for the page that served this setup route. */
export function setupGatewayWsUrl(loc: Location = window.location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}`;
}
