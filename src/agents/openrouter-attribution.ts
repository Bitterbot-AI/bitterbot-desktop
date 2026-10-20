/**
 * OpenRouter app attribution (https://openrouter.ai/docs/app-attribution).
 *
 * Every request Bitterbot sends to OpenRouter carries these headers so its
 * usage counts toward the Bitterbot app page, the public rankings, and the
 * "Apps" tab on each model page. That includes background work (dreams,
 * memory extraction, curator, judges) and vision calls, not just chat.
 *
 * `HTTP-Referer` is the app's identity on OpenRouter: changing it starts a new
 * app with no history, so keep it stable. The title is required for
 * attribution from localhost-origin apps like a self-hosted gateway.
 */

export const BITTERBOT_APP_URL = "https://bitterbot.ai";
export const BITTERBOT_APP_TITLE = "Bitterbot";
/** At most 2 per request; lowercase from OpenRouter's recognized list (unknown ones are dropped). */
export const BITTERBOT_APP_CATEGORIES = ["personal-agent", "general-chat"] as const;

export const OPENROUTER_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "HTTP-Referer": BITTERBOT_APP_URL,
  "X-OpenRouter-Title": BITTERBOT_APP_TITLE,
  // Legacy name for the title header, still honored; kept so older
  // OpenRouter-compatible proxies see a title too.
  "X-Title": BITTERBOT_APP_TITLE,
  "X-OpenRouter-Categories": BITTERBOT_APP_CATEGORIES.join(","),
});

/** True when a request to this provider/base URL is served by OpenRouter. */
export function isOpenRouterTarget(target: { provider?: string; baseUrl?: string }): boolean {
  if (target.provider?.trim().toLowerCase() === "openrouter") {
    return true;
  }
  const baseUrl = target.baseUrl?.trim();
  if (!baseUrl) {
    return false;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * Headers for a request: attribution added when the target is OpenRouter.
 * Caller-supplied headers win, so a deliberate override is respected.
 */
export function withOpenRouterAttribution(
  target: { provider?: string; baseUrl?: string },
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!isOpenRouterTarget(target)) {
    return headers;
  }
  return { ...OPENROUTER_ATTRIBUTION_HEADERS, ...headers };
}
