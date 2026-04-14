/**
 * URL finder for Skill Seekers gap-filling.
 *
 * Companion to the Skill Seekers adapter. Skill Seekers
 * (https://github.com/yusufkaraaslan/Skill_Seekers) by Yusuf Karaaslan (MIT)
 * requires a URL to scrape; this module supplies one when the dream engine's
 * knowledge gaps are expressed as natural language rather than links.
 *
 * Given a gap description like "How do Next.js App Router route handlers work?",
 * it queries the user's configured web search provider (Brave by default) and
 * returns the most authoritative documentation URL it can find.
 *
 * Intentionally conservative: returns null if no high-quality result can be
 * found, so the adapter falls through gracefully rather than scraping
 * low-value pages.
 */

import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

const log = createSubsystemLogger("skill-seekers-url-finder");

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const FINDER_TIMEOUT_MS = 8_000;
const FINDER_RESULT_COUNT = 5;

// Hosts considered high-signal sources of truth for skill generation.
const AUTHORITATIVE_HINTS = [
  "docs.",
  "developer.",
  "reference.",
  "/docs/",
  "/reference/",
  "/guide/",
  "github.com",
  "readthedocs.io",
  "gitbook.io",
  "mdn.mozilla.org",
  "developer.mozilla.org",
  "kubernetes.io",
  "python.org",
  "nodejs.org",
];

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
};

type BraveSearchResponse = {
  web?: { results?: BraveSearchResult[] };
};

export interface SkillSeekersUrlFinder {
  findAuthoritativeUrl(query: string, hints?: { category?: string }): Promise<string | null>;
}

/**
 * Build a URL finder from the Bitterbot config. Returns null if web search is
 * disabled or no API key is configured — the adapter will then skip the
 * fallback entirely rather than failing loudly.
 */
export function buildUrlFinder(cfg: BitterbotConfig | null): SkillSeekersUrlFinder | null {
  if (!cfg) {
    return null;
  }
  const search = cfg.tools?.web?.search;
  if (!search || search.enabled === false) {
    return null;
  }
  // Only Brave is wired for now — it's the default and has a simple API surface.
  // Perplexity/Grok/Tavily provide richer answers but would over-index on LLM
  // synthesis rather than pointing to a canonical docs URL.
  const provider = typeof search.provider === "string" ? search.provider : "brave";
  if (provider !== "brave") {
    return null;
  }
  const apiKey =
    normalizeSecretInput(typeof search.apiKey === "string" ? search.apiKey : "") ||
    normalizeSecretInput(process.env.BRAVE_API_KEY);
  if (!apiKey) {
    return null;
  }
  return new BraveUrlFinder(apiKey);
}

class BraveUrlFinder implements SkillSeekersUrlFinder {
  constructor(private readonly apiKey: string) {}

  async findAuthoritativeUrl(query: string, hints?: { category?: string }): Promise<string | null> {
    // Bias the query toward documentation by appending "docs" or the hinted category.
    const refinedQuery = hints?.category
      ? `${query} ${hints.category} documentation`
      : `${query} documentation`;

    const params = new URLSearchParams({
      q: refinedQuery,
      count: String(FINDER_RESULT_COUNT),
      safesearch: "moderate",
    });
    const url = `${BRAVE_ENDPOINT}?${params.toString()}`;

    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: AbortSignal.timeout(FINDER_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.debug(`Brave search returned HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as BraveSearchResponse;
      const results = data.web?.results ?? [];
      return pickAuthoritative(results);
    } catch (err) {
      log.debug(`URL finder error: ${String(err)}`);
      return null;
    }
  }
}

function pickAuthoritative(results: BraveSearchResult[]): string | null {
  // Score each result by how many authoritative signals it contains.
  let best: { url: string; score: number } | null = null;
  for (const result of results) {
    const url = result.url;
    if (!url) {
      continue;
    }
    let score = 0;
    const haystack = `${url.toLowerCase()} ${result.title?.toLowerCase() ?? ""}`;
    for (const hint of AUTHORITATIVE_HINTS) {
      if (haystack.includes(hint)) {
        score += 1;
      }
    }
    // Prefer HTTPS
    if (url.startsWith("https://")) {
      score += 1;
    }
    if (!best || score > best.score) {
      best = { url, score };
    }
  }
  if (!best || best.score < 2) {
    // Require at least two signals (e.g. https + docs.) before we'll scrape.
    return null;
  }
  return best.url;
}
