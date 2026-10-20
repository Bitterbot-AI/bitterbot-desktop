import { VERSION } from "../../version.js";
import { readResponseText } from "./web-shared.js";

const SERPLY_SEARCH_ENDPOINT = "https://api.serply.io/v1/search";

/** Serply forwards Google's `tbs` time filter; only the relative windows map. */
const SERPLY_FRESHNESS_TBS: Record<string, string> = {
  pd: "qdr:d",
  pw: "qdr:w",
  pm: "qdr:m",
  py: "qdr:y",
};

export type SerplySearchResult = {
  title: string;
  url: string;
  description: string;
};

export function serplySupportsFreshness(freshness: string): boolean {
  return freshness in SERPLY_FRESHNESS_TBS;
}

/** Keyed Google web results from Serply's REST API (one results page per call). */
export async function runSerplySearch(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  freshness?: string;
  signal?: AbortSignal;
}): Promise<SerplySearchResult[]> {
  const deadline = AbortSignal.timeout(params.timeoutSeconds * 1000);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
  signal.throwIfAborted();

  const url = new URL(SERPLY_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("num", String(params.count));
  const country = params.country?.trim().toLowerCase();
  if (country && country !== "all") {
    url.searchParams.set("gl", country);
  }
  const tbs = params.freshness ? SERPLY_FRESHNESS_TBS[params.freshness] : undefined;
  if (tbs) {
    url.searchParams.set("tbs", tbs);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Api-Key": params.apiKey,
      "User-Agent": `Bitterbot/${VERSION}`,
    },
    signal,
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Serply API error (${res.status}): ${detail || res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) {
    throw new Error("Serply returned an invalid search response.");
  }
  return data.results
    .flatMap((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("link" in entry) ||
        typeof entry.link !== "string"
      ) {
        return [];
      }
      try {
        const link = new URL(entry.link);
        if (link.protocol !== "https:" && link.protocol !== "http:") return [];
      } catch {
        return [];
      }
      return [
        {
          url: entry.link,
          title: "title" in entry && typeof entry.title === "string" ? entry.title : "",
          description:
            "description" in entry && typeof entry.description === "string"
              ? entry.description
              : "",
        },
      ];
    })
    .slice(0, params.count);
}
