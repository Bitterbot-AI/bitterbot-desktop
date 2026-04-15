/**
 * Proactive trending sweep (PLAN-11 Gap 2).
 *
 * While the dream engine reactively scrapes when curiosity targets have URLs,
 * this module does the opposite: on a fixed cadence (default 24h), it asks
 * "what's trending in the world?" and proactively generates skills for those
 * topics. Closes the gap where the agent would never learn a hot library
 * until a user asked about it.
 *
 * Sources supported (all configurable):
 *   - GitHub trending repos (no API key needed for the HTML endpoint)
 *   - HackerNews top stories (Firebase API)
 *   - Curated feed — a user-provided list of URLs
 *
 * Dedup:
 *   - We skip URLs already scraped (checked via the reconciler's path).
 *   - The reconciler itself then handles per-skill dedup after scraping.
 *
 * Budget:
 *   - Honors skills.skillSeekers.maxSkillsPerCycle through the adapter.
 *   - Has its own maxPerSweep cap on top to prevent over-eager scraping.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skill-seekers-trending");

const TRENDING_TIMEOUT_MS = 15_000;
const GITHUB_TRENDING_URL = "https://api.github.com/search/repositories";
const HN_TOPSTORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

// ── Types ──

export type TrendingSourceKind = "github" | "hackernews" | "curated";

export type TrendingSourceConfig = {
  kind: TrendingSourceKind;
  /** For github: the search "since" window ("daily" | "weekly" | "monthly"). */
  since?: "daily" | "weekly" | "monthly";
  /** For github: minimum star count to consider. Default 100. */
  minStars?: number;
  /** For hackernews: minimum point count to consider. Default 100. */
  minPoints?: number;
  /** For curated: list of URLs. */
  urls?: string[];
  /** Max items to harvest from this source per sweep. Default 10. */
  limit?: number;
};

export type TrendingCandidate = {
  url: string;
  source: TrendingSourceKind;
  title: string;
  score: number;
};

export type TrendingSweepResult = {
  candidates: TrendingCandidate[];
  scraped: number;
  skipped: number;
  elapsedMs: number;
};

// ── Public API ──

export async function fetchTrendingCandidates(
  sources: TrendingSourceConfig[],
  opts: { now?: number } = {},
): Promise<TrendingCandidate[]> {
  const now = opts.now ?? Date.now();
  const results: TrendingCandidate[] = [];
  for (const src of sources) {
    try {
      if (src.kind === "github") {
        results.push(...(await fetchGithubTrending(src, now)));
      } else if (src.kind === "hackernews") {
        results.push(...(await fetchHackerNewsTrending(src)));
      } else if (src.kind === "curated") {
        results.push(...fetchCurated(src));
      }
    } catch (err) {
      log.warn(
        `trending source ${src.kind} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return results;
}

export type TrendingAdapter = {
  ingestBatch(
    sources: Array<{ url: string; type?: string; name?: string; description?: string }>,
  ): Promise<{ total: number; succeeded: number; failed: number; results: unknown[] }>;
  budgetRemaining(): number;
};

/**
 * Run a full sweep: fetch trending candidates, dedup, and hand off the
 * top N to the Skill Seekers adapter for batch ingestion.
 *
 * The adapter itself enforces the per-cycle budget + domain filter +
 * reconciliation, so this function is a thin coordinator.
 */
export async function runTrendingSweep(
  adapter: TrendingAdapter,
  sources: TrendingSourceConfig[],
  opts: { maxPerSweep?: number; alreadyScrapedUrls?: Set<string>; now?: number } = {},
): Promise<TrendingSweepResult> {
  const start = Date.now();
  const maxPerSweep = opts.maxPerSweep ?? 10;
  const alreadyScraped = opts.alreadyScrapedUrls ?? new Set<string>();

  const candidates = await fetchTrendingCandidates(sources, { now: opts.now });
  // Dedup against adapter cap and sweep cap.
  const deduped: TrendingCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.url) || alreadyScraped.has(c.url)) {
      continue;
    }
    seen.add(c.url);
    deduped.push(c);
  }
  // Sort by score desc, then cap at maxPerSweep AND the adapter's remaining budget.
  deduped.sort((a, b) => b.score - a.score);
  const budget = Math.min(maxPerSweep, adapter.budgetRemaining());
  const selected = deduped.slice(0, Math.max(0, budget));
  const skippedCount = deduped.length - selected.length;

  if (selected.length === 0) {
    return {
      candidates: deduped,
      scraped: 0,
      skipped: skippedCount,
      elapsedMs: Date.now() - start,
    };
  }

  const batch = await adapter.ingestBatch(
    selected.map((c) => ({
      url: c.url,
      type: c.source === "github" ? "github" : "docs",
      name: c.title,
    })),
  );

  log.info(
    `trending sweep: ${batch.succeeded}/${batch.total} scraped from ${sources.length} source(s) (${skippedCount} skipped)`,
  );

  return {
    candidates: deduped,
    scraped: batch.succeeded,
    skipped: skippedCount + (batch.failed ?? 0),
    elapsedMs: Date.now() - start,
  };
}

// ── Source fetchers ──

async function fetchGithubTrending(
  src: TrendingSourceConfig,
  now: number,
): Promise<TrendingCandidate[]> {
  const since = src.since ?? "weekly";
  const limit = src.limit ?? 10;
  const minStars = src.minStars ?? 100;
  const sinceDate = trendingSinceDate(since, now);
  // Use the official search API: `created:>YYYY-MM-DD` isn't quite right for
  // "trending" but it's a reasonable proxy (recently-created popular repos).
  const params = new URLSearchParams({
    q: `stars:>${minStars} pushed:>${sinceDate}`,
    sort: "stars",
    order: "desc",
    per_page: String(Math.min(limit, 50)),
  });
  const url = `${GITHUB_TRENDING_URL}?${params.toString()}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Bitterbot-SkillSeekers/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TRENDING_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`github trending returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      html_url?: string;
      full_name?: string;
      description?: string | null;
      stargazers_count?: number;
    }>;
  };
  const items = data.items ?? [];
  return items
    .slice(0, limit)
    .map((item) => ({
      url: item.html_url ?? "",
      source: "github" as const,
      title: item.full_name ?? "github-repo",
      score: typeof item.stargazers_count === "number" ? item.stargazers_count : 0,
    }))
    .filter((c) => c.url.length > 0);
}

async function fetchHackerNewsTrending(src: TrendingSourceConfig): Promise<TrendingCandidate[]> {
  const limit = src.limit ?? 10;
  const minPoints = src.minPoints ?? 100;

  const idsRes = await fetch(HN_TOPSTORIES_URL, {
    signal: AbortSignal.timeout(TRENDING_TIMEOUT_MS),
  });
  if (!idsRes.ok) {
    throw new Error(`hackernews topstories returned HTTP ${idsRes.status}`);
  }
  const ids = (await idsRes.json()) as number[];
  // Only inspect the top 30 — don't hammer the API walking all 500.
  const checkIds = ids.slice(0, 30);
  const results: TrendingCandidate[] = [];

  for (const id of checkIds) {
    if (results.length >= limit) {
      break;
    }
    try {
      const itemRes = await fetch(HN_ITEM_URL(id), {
        signal: AbortSignal.timeout(TRENDING_TIMEOUT_MS),
      });
      if (!itemRes.ok) {
        continue;
      }
      const item = (await itemRes.json()) as {
        url?: string;
        title?: string;
        score?: number;
        type?: string;
      };
      if (item.type !== "story" || !item.url || (item.score ?? 0) < minPoints) {
        continue;
      }
      // HN links go to all kinds of URLs — filter to ones the native scraper
      // or upstream can reasonably handle. Github + docs + blog posts only.
      if (!looksLikeScrapableSource(item.url)) {
        continue;
      }
      results.push({
        url: item.url,
        source: "hackernews",
        title: item.title ?? "HN story",
        score: item.score ?? 0,
      });
    } catch {
      // skip individual item errors — keep walking
    }
  }

  return results;
}

function fetchCurated(src: TrendingSourceConfig): TrendingCandidate[] {
  const urls = src.urls ?? [];
  return urls.slice(0, src.limit ?? urls.length).map((url, idx) => ({
    url,
    source: "curated" as const,
    title: safeHostname(url) ?? `curated-${idx}`,
    // Curated sources are inherently high-priority — user picked them.
    score: 1_000_000 - idx,
  }));
}

// ── Helpers ──

export function trendingSinceDate(since: "daily" | "weekly" | "monthly", now: number): string {
  const d = new Date(now);
  if (since === "daily") {
    d.setUTCDate(d.getUTCDate() - 1);
  } else if (since === "weekly") {
    d.setUTCDate(d.getUTCDate() - 7);
  } else if (since === "monthly") {
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return d.toISOString().slice(0, 10);
}

export function looksLikeScrapableSource(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".pdf") || path.endsWith(".ipynb")) {
      return false;
    }
    // Media-heavy / short-form hosts — low scrape value
    const blocked = [
      "twitter.com",
      "x.com",
      "youtube.com",
      "youtu.be",
      "reddit.com",
      "news.ycombinator.com",
    ];
    if (blocked.some((b) => host === b || host.endsWith(`.${b}`))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
