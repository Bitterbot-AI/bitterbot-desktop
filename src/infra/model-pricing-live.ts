/**
 * PLAN-50 Phase 5: time-aware live pricing overlay.
 *
 * The vendored catalog and the embedding table are static. This module keeps dated snapshots of
 * OpenRouter's public model list (`GET /api/v1/models`, USD-per-token strings including
 * `input_cache_read`, `input_cache_write`, `input_cache_write_1h`) under
 * `<state>/model-pricing/openrouter-YYYY-MM-DD.json`, refreshes once a day, and answers
 * "what did this model cost on this date?" for models the static tiers do not know.
 *
 * It is an overlay, not the source of truth: config overrides and the vendored catalog still
 * win, because provider ids and model names differ between OpenRouter and native APIs and a
 * fuzzy match must never overrule a known price.
 */

import fs from "node:fs";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import type { ModelPrice } from "./usage-ledger.types.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("model-pricing-live");

export const DEFAULT_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const SNAPSHOT_KEEP = 60;
const REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
const FIRST_REFRESH_DELAY_MS = 3_000;
const FETCH_TIMEOUT_MS = 20_000;

export type LivePriceEntry = ModelPrice & {
  /** Anthropic-style 1-hour cache write price, per 1M tokens, when published. */
  cacheWrite1h?: number;
};

export type PricingSnapshot = {
  source: "openrouter";
  fetchedAt: number;
  entries: Record<string, LivePriceEntry>;
};

type LiveState = {
  snapshots: PricingSnapshot[];
  timer: NodeJS.Timeout | null;
  firstTimer: NodeJS.Timeout | null;
  loadedFrom: string | null;
  lastError: string | null;
};

const state: LiveState = {
  snapshots: [],
  timer: null,
  firstTimer: null,
  loadedFrom: null,
  lastError: null,
};

/** Normalize `provider/model` so OpenRouter ids and native ids meet: lowercase, dots to dashes,
 *  drop date suffixes and `:free`-style variants. */
export function normalizePricingKey(provider: string, model: string): string {
  const p = provider.trim().toLowerCase();
  let m = model.trim().toLowerCase();
  m = m.replace(/^models\//, "");
  m = m.replace(/:(free|beta|thinking|extended|online|nitro)$/g, "");
  m = m.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  m = m.replace(/-latest$/, "");
  m = m.replace(/\./g, "-");
  return `${p}/${m}`;
}

function snapshotDir(): string {
  return path.join(resolveStateDir(), "model-pricing");
}

function perMillion(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return n * 1_000_000;
}

/** Parse an OpenRouter `/api/v1/models` payload into a snapshot. Exported for tests. */
export function parseOpenRouterModels(payload: unknown, fetchedAt = Date.now()): PricingSnapshot {
  const entries: Record<string, LivePriceEntry> = {};
  const datedKeys = new Set<string>();
  const data = (payload as { data?: unknown[] } | undefined)?.data;
  for (const item of Array.isArray(data) ? data : []) {
    const rec = item as { id?: unknown; pricing?: Record<string, unknown> };
    if (typeof rec.id !== "string" || !rec.pricing || typeof rec.pricing !== "object") {
      continue;
    }
    // Variants (`:free`, `:thinking`, `:nitro`, …) are different SKUs with different prices;
    // folding them into the base key let a free twin zero a paid model. Skip them outright.
    if (rec.id.includes(":")) {
      continue;
    }
    const slash = rec.id.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const input = perMillion(rec.pricing.prompt);
    const output = perMillion(rec.pricing.completion);
    // A model with no prompt and no completion price is unknown, not free.
    if (!input && !output) {
      continue;
    }
    const rawModel = rec.id.slice(slash + 1);
    const key = normalizePricingKey(rec.id.slice(0, slash), rawModel);
    const dated = /-(\d{8}|\d{4}-\d{2}-\d{2})$/.test(rawModel);
    // On collision the undated (alias) id wins; a dated id never overwrites an existing entry.
    if (entries[key] && (dated || !datedKeys.has(key))) {
      continue;
    }
    const entry: LivePriceEntry = {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: perMillion(rec.pricing.input_cache_read) ?? 0,
      cacheWrite: perMillion(rec.pricing.input_cache_write) ?? 0,
    };
    const write1h = perMillion(rec.pricing.input_cache_write_1h);
    if (write1h !== undefined && write1h > 0) {
      entry.cacheWrite1h = write1h;
    }
    entries[key] = entry;
    if (dated) {
      datedKeys.add(key);
    } else {
      datedKeys.delete(key);
    }
  }
  return { source: "openrouter", fetchedAt, entries };
}

function snapshotFileName(fetchedAt: number): string {
  return `openrouter-${new Date(fetchedAt).toISOString().slice(0, 10)}.json`;
}

/** Load every snapshot on disk (newest last). Safe to call repeatedly. */
export function loadPricingSnapshots(dir = snapshotDir()): PricingSnapshot[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^openrouter-\d{4}-\d{2}-\d{2}\.json$/.test(n));
  } catch {
    state.snapshots = [];
    state.loadedFrom = dir;
    return state.snapshots;
  }
  const loaded: PricingSnapshot[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as PricingSnapshot;
      if (parsed && typeof parsed.fetchedAt === "number" && parsed.entries) {
        loaded.push(parsed);
      }
    } catch {
      // skip corrupt snapshot
    }
  }
  state.snapshots = loaded.toSorted((a, b) => a.fetchedAt - b.fetchedAt).slice(-SNAPSHOT_KEEP);
  state.loadedFrom = dir;
  return state.snapshots;
}

export function setPricingSnapshotsForTest(snapshots: PricingSnapshot[]): void {
  state.snapshots = snapshots.toSorted((a, b) => a.fetchedAt - b.fetchedAt);
}

/** Price in force at `ts` (latest snapshot at or before it; the earliest one for older rows). */
export function lookupLivePrice(
  provider: string,
  model: string,
  ts?: number,
): { price: LivePriceEntry; snapshotAt: number } | undefined {
  if (state.snapshots.length === 0) {
    return undefined;
  }
  const key = normalizePricingKey(provider, model);
  const at = typeof ts === "number" && Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
  let chosen: PricingSnapshot | undefined;
  for (const snap of state.snapshots) {
    if (snap.fetchedAt <= at) {
      chosen = snap;
    }
  }
  chosen ??= state.snapshots[0];
  const candidates = chosen
    ? [chosen, ...state.snapshots.filter((s) => s !== chosen).toReversed()]
    : [];
  for (const snap of candidates) {
    const entry = snap.entries[key];
    if (entry) {
      return { price: entry, snapshotAt: snap.fetchedAt };
    }
  }
  return undefined;
}

export async function refreshOpenRouterPricing(opts?: {
  url?: string;
  fetchFn?: typeof fetch;
  dir?: string;
  now?: number;
}): Promise<PricingSnapshot | null> {
  const url = opts?.url ?? DEFAULT_OPENROUTER_MODELS_URL;
  const fetchFn = opts?.fetchFn ?? fetch;
  const dir = opts?.dir ?? snapshotDir();
  const now = opts?.now ?? Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let payload: unknown;
    try {
      const res = await fetchFn(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      payload = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const snapshot = parseOpenRouterModels(payload, now);
    if (Object.keys(snapshot.entries).length === 0) {
      throw new Error("no priced models in response");
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, snapshotFileName(now)), JSON.stringify(snapshot));
    // Prune to the newest N snapshots.
    const names = fs
      .readdirSync(dir)
      .filter((n) => /^openrouter-\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .toSorted((a, b) => a.localeCompare(b));
    for (const stale of names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))) {
      try {
        fs.unlinkSync(path.join(dir, stale));
      } catch {
        // ignore
      }
    }
    loadPricingSnapshots(dir);
    state.lastError = null;
    log.info(
      `live pricing snapshot: ${Object.keys(snapshot.entries).length} models from OpenRouter`,
    );
    return snapshot;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    log.debug(`live pricing refresh failed: ${state.lastError}`);
    return null;
  }
}

export function isLivePricingEnabled(cfg: BitterbotConfig | undefined): boolean {
  const raw = (cfg as { usage?: { pricing?: { liveRefresh?: boolean } } } | undefined)?.usage
    ?.pricing?.liveRefresh;
  return raw !== false;
}

export function resolveOpenRouterModelsUrl(cfg: BitterbotConfig | undefined): string {
  const raw = (cfg as { usage?: { pricing?: { openRouterUrl?: string } } } | undefined)?.usage
    ?.pricing?.openRouterUrl;
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_OPENROUTER_MODELS_URL;
}

/**
 * Gateway boot: load snapshots and schedule a daily refresh. Returns a promise that resolves once
 * the first refresh has completed (or immediately when the newest snapshot is fresh), so the
 * transcript backfill can wait for prices before pricing history.
 */
export function startPricingRefresh(opts?: { cfg?: BitterbotConfig }): Promise<void> {
  loadPricingSnapshots();
  if (!isLivePricingEnabled(opts?.cfg) || state.timer) {
    return Promise.resolve();
  }
  const url = resolveOpenRouterModelsUrl(opts?.cfg);
  const newest = state.snapshots.at(-1);
  const stale = !newest || Date.now() - newest.fetchedAt > REFRESH_INTERVAL_MS;
  const run = () => void refreshOpenRouterPricing({ url });
  state.timer = setInterval(run, REFRESH_INTERVAL_MS);
  state.timer.unref?.();
  if (!stale) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    state.firstTimer = setTimeout(() => {
      state.firstTimer = null;
      void refreshOpenRouterPricing({ url }).finally(resolve);
    }, FIRST_REFRESH_DELAY_MS);
    state.firstTimer.unref?.();
  });
}

export function stopPricingRefresh(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.firstTimer) {
    clearTimeout(state.firstTimer);
    state.firstTimer = null;
  }
}

export function getLivePricingStatus(): {
  snapshots: number;
  newestAt: number | null;
  entries: number;
  lastError: string | null;
} {
  const newest = state.snapshots.at(-1);
  return {
    snapshots: state.snapshots.length,
    newestAt: newest?.fetchedAt ?? null,
    entries: newest ? Object.keys(newest.entries).length : 0,
    lastError: state.lastError,
  };
}
