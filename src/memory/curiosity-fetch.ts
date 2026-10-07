/**
 * PLAN-54: the one way curiosity research reads a web page. SSRF-guarded
 * (private ranges, redirects, DNS pinning as the web_fetch tool), byte-capped,
 * readability-extracted, and never more than one request per call.
 */

import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";

const MAX_BYTES = 1_500_000;
const MAX_CHARS = 12_000;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; Bitterbot-curiosity/1.0; +https://bitterbot.ai)";

export async function fetchReadablePage(
  url: string,
): Promise<{ text: string; title?: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const guarded = await fetchWithSsrFGuard({
    url,
    maxRedirects: 3,
    timeoutMs: TIMEOUT_MS,
    auditContext: "curiosity-research",
    init: {
      headers: {
        Accept: "text/html;q=0.9, text/plain;q=0.8, */*;q=0.1",
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
  });
  try {
    const res = guarded.response;
    if (!res.ok) {
      return null;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const { readResponseText } = await import("../agents/tools/web-shared.js");
    const body = await readResponseText(res, { maxBytes: MAX_BYTES });
    if (!body.text) {
      return null;
    }
    if (contentType.includes("text/html") || /^\s*<!doctype html|<html/i.test(body.text)) {
      const { extractReadableContent } = await import("../agents/tools/web-fetch-utils.js");
      const readable = await extractReadableContent({
        html: body.text,
        url: guarded.finalUrl,
        extractMode: "text",
      });
      if (!readable?.text) {
        return null;
      }
      return { text: readable.text.slice(0, MAX_CHARS), title: readable.title };
    }
    if (contentType.includes("text/") || contentType.includes("json")) {
      return { text: body.text.slice(0, MAX_CHARS) };
    }
    return null;
  } finally {
    await guarded.release();
  }
}
