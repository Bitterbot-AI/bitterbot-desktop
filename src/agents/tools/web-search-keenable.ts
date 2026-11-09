import { VERSION } from "../../version.js";
import { readResponseText } from "./web-shared.js";

const KEENABLE_PUBLIC_SEARCH_ENDPOINT = "https://api.keenable.ai/v1/search/public";
const KEENABLE_SEARCH_ENDPOINT = "https://api.keenable.ai/v1/search";
/** Keenable returns several thousand characters of page text per result unless capped. */
const KEENABLE_SNIPPET_MAX_LENGTH = 1000;
/** Error bodies reach the model; under load the keyless endpoint may answer with an HTML page. */
const KEENABLE_ERROR_MAX_BYTES = 4_000;
const KEENABLE_ERROR_MAX_CHARS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Relative windows as days back from now; Keenable filters on publication date. */
const KEENABLE_FRESHNESS_DAYS: Record<string, number> = {
  pd: 1,
  pw: 7,
  pm: 30,
  py: 365,
};
const KEENABLE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

export type KeenableSearchResult = {
  title: string;
  url: string;
  description: string;
};

/**
 * Normalized `freshness` (pd/pw/pm/py or YYYY-MM-DDtoYYYY-MM-DD) as Keenable's
 * publication-date window. A full date as `published_before` covers that whole day.
 */
export function keenablePublishedWindow(
  freshness: string | undefined,
  now = Date.now(),
): { published_after?: string; published_before?: string } {
  if (!freshness) {
    return {};
  }
  const days = KEENABLE_FRESHNESS_DAYS[freshness];
  if (days) {
    return { published_after: new Date(now - days * DAY_MS).toISOString() };
  }
  const range = freshness.match(KEENABLE_FRESHNESS_RANGE);
  return range ? { published_after: range[1], published_before: range[2] } : {};
}

/** First non-empty line of an error body, whitespace collapsed and capped. */
function keenableErrorDetail(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  return line.length > KEENABLE_ERROR_MAX_CHARS
    ? `${line.slice(0, KEENABLE_ERROR_MAX_CHARS)}…`
    : line;
}

/**
 * Keenable web results with page snippets. Keyless by default (`/v1/search/public`,
 * limited per IP); an API key switches to `/v1/search` and only lifts the limits.
 */
export async function runKeenableSearch(params: {
  query: string;
  apiKey?: string;
  count: number;
  timeoutSeconds: number;
  freshness?: string;
  signal?: AbortSignal;
}): Promise<KeenableSearchResult[]> {
  const deadline = AbortSignal.timeout(params.timeoutSeconds * 1000);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
  signal.throwIfAborted();

  try {
    return await requestKeenableSearch(params, signal);
  } catch (err) {
    if (deadline.aborted && !params.signal?.aborted) {
      throw new Error(`Keenable search timed out after ${params.timeoutSeconds}s.`, {
        cause: err,
      });
    }
    throw err;
  }
}

async function requestKeenableSearch(
  params: { query: string; apiKey?: string; count: number; freshness?: string },
  signal: AbortSignal,
): Promise<KeenableSearchResult[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Keenable-Title": "Bitterbot",
    "User-Agent": `Bitterbot/${VERSION}`,
  };
  if (params.apiKey) {
    headers["X-API-Key"] = params.apiKey;
  }

  const res = await fetch(
    params.apiKey ? KEENABLE_SEARCH_ENDPOINT : KEENABLE_PUBLIC_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: params.query,
        max_results: params.count,
        snippet_max_length: KEENABLE_SNIPPET_MAX_LENGTH,
        ...keenablePublishedWindow(params.freshness),
      }),
      signal,
    },
  );

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: KEENABLE_ERROR_MAX_BYTES });
    const detail = keenableErrorDetail(detailResult.text) || res.statusText;
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const hint = params.apiKey
        ? ""
        : " Keyless search is limited per IP; set KEENABLE_API_KEY or tools.web.search.keenable.apiKey to lift the hourly limit.";
      throw new Error(
        `Keenable rate limit reached (429${retryAfter ? `, Retry-After: ${retryAfter}` : ""}).${hint} ${detail}`,
      );
    }
    throw new Error(`Keenable API error (${res.status}): ${detail}`);
  }

  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) {
    throw new Error("Keenable returned an invalid search response.");
  }
  return data.results
    .flatMap((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("url" in entry) ||
        typeof entry.url !== "string"
      ) {
        return [];
      }
      try {
        const url = new URL(entry.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") return [];
      } catch {
        return [];
      }
      // Page text arrives in `snippet`; `description` is usually empty.
      const snippet = "snippet" in entry && typeof entry.snippet === "string" ? entry.snippet : "";
      const description =
        "description" in entry && typeof entry.description === "string" ? entry.description : "";
      return [
        {
          url: entry.url,
          title: "title" in entry && typeof entry.title === "string" ? entry.title : "",
          description: snippet || description,
        },
      ];
    })
    .slice(0, params.count);
}
