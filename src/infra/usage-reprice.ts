/**
 * PLAN-50 `reprice:borrowed:v1`: one-time correction of rows priced with a borrowed price.
 *
 * A Claude id newer than the vendored pi-ai catalog (claude-fable-5-1, claude-opus-5-5, ...)
 * resolves through model-forward-compat, which clones an older model's entry INCLUDING its cost.
 * Until the ledger learned to prefer the exact live price, those turns were recorded with
 * `cost_source = 'provider'` at the template's price (Fable at Opus's $5/$25 per M instead of
 * $10/$50). This pass re-prices exactly those rows from their token columns at the live snapshot
 * in force at each row's `ts`.
 *
 * Eligible: `cost_source = 'provider'` rows whose provider is a built-in pi-ai provider, whose
 * model id is NOT in the vendored catalog for that provider, that have no config price override,
 * and whose normalized `provider/model` key is an exact entry in a pricing snapshot. Nothing else
 * is touched, no row is deleted, and the run is recorded in `usage_meta` (with the per-model old
 * and new totals) so it happens once. It does not mark itself done while no snapshot is loaded,
 * so a node that boots offline corrects its history on a later start.
 */

import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getLivePricingStatus, lookupLivePrice } from "./model-pricing-live.js";
import { priceUsageSplit, type RepriceRow, type UsageLedger } from "./usage-ledger.js";
import type { CacheTtlLabel, ModelPrice, UsageBuckets } from "./usage-ledger.types.js";

const log = createSubsystemLogger("usage-reprice");

export const REPRICE_BORROWED_META_KEY = "reprice:borrowed:v1";

export type RepriceGroup = {
  provider: string;
  model: string;
  rows: number;
  oldTotal: number;
  newTotal: number;
};

export type RepriceBorrowedResult = {
  /** False when the pass already ran, or could not run yet (no snapshot loaded). */
  ran: boolean;
  reason?: "already-ran" | "no-snapshots";
  rows: number;
  groups: RepriceGroup[];
};

/** Whether `provider/model` is a vendored pi-ai catalog entry; null when the provider is not built in. */
export type VendoredCatalogCheck = (provider: string, model: string) => boolean | null;

async function defaultVendoredCheck(): Promise<VendoredCatalogCheck> {
  const { getModels, getProviders } = await import("@mariozechner/pi-ai");
  const providers = new Set<string>(getProviders());
  const ids = new Map<string, Set<string>>();
  return (provider, model) => {
    if (!providers.has(provider)) {
      return null;
    }
    let set = ids.get(provider);
    if (!set) {
      set = new Set(
        (getModels(provider as Parameters<typeof getModels>[0]) as Array<{ id: string }>).map(
          (m) => m.id,
        ),
      );
      ids.set(provider, set);
    }
    return set.has(model);
  };
}

/** A config-declared model never came from forward-compat; its price is the user's. */
function hasConfigEntry(cfg: BitterbotConfig | undefined, provider: string, model: string) {
  const entry = cfg?.models?.providers?.[provider]?.models?.find((m) => m.id === model);
  return Boolean(entry);
}

function rowUsage(row: RepriceRow): UsageBuckets {
  return {
    input: row.input,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    output: row.output,
    reasoning: row.reasoning,
    total: row.total,
  };
}

function rowSplit(row: RepriceRow): { cacheWrite5m: number; cacheWrite1h: number } | null {
  if (row.cache_write_5m === null && row.cache_write_1h === null) {
    return null;
  }
  return { cacheWrite5m: row.cache_write_5m ?? 0, cacheWrite1h: row.cache_write_1h ?? 0 };
}

/** Pick the identities and price every eligible row; `apply` writes, otherwise a dry run. */
export async function planBorrowedReprice(params: {
  ledger: UsageLedger;
  cfg?: BitterbotConfig;
  isVendored?: VendoredCatalogCheck;
  apply?: boolean;
}): Promise<{ rows: number; groups: RepriceGroup[] }> {
  const isVendored = params.isVendored ?? (await defaultVendoredCheck());
  const groups: RepriceGroup[] = [];
  let rows = 0;
  for (const identity of params.ledger.providerCostIdentities()) {
    const { provider, model } = identity;
    if (isVendored(provider, model) !== false || hasConfigEntry(params.cfg, provider, model)) {
      continue;
    }
    if (!lookupLivePrice(provider, model)) {
      continue;
    }
    const group: RepriceGroup = { provider, model, rows: 0, oldTotal: 0, newTotal: 0 };
    const candidates = params.ledger.providerCostRows(provider, model);
    const write = () => {
      for (const row of candidates) {
        const live = lookupLivePrice(provider, model, row.ts);
        if (!live) {
          continue;
        }
        const price: ModelPrice = { ...live.price };
        const cost = priceUsageSplit(price, rowUsage(row), rowSplit(row), {
          batch: row.batch === 1,
          cacheTtl: (row.cache_ttl as CacheTtlLabel | null) ?? null,
          provider,
          source: "live",
        });
        if (params.apply && params.ledger.applyRepricedCost(row.id, cost, price, "live") === 0) {
          continue;
        }
        group.rows += 1;
        group.oldTotal += row.cost_total;
        group.newTotal += cost.total;
      }
    };
    if (params.apply) {
      params.ledger.transaction(write);
    } else {
      write();
    }
    if (group.rows > 0) {
      groups.push(group);
      rows += group.rows;
    }
    // Keep the gateway responsive between identities.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { rows, groups };
}

/** Gateway boot: run the correction once (recorded in usage_meta). */
export async function repriceBorrowedRows(params: {
  ledger: UsageLedger;
  cfg?: BitterbotConfig;
  isVendored?: VendoredCatalogCheck;
}): Promise<RepriceBorrowedResult> {
  if (params.ledger.getMeta(REPRICE_BORROWED_META_KEY) !== null) {
    return { ran: false, reason: "already-ran", rows: 0, groups: [] };
  }
  if (getLivePricingStatus().snapshots === 0) {
    return { ran: false, reason: "no-snapshots", rows: 0, groups: [] };
  }
  const { rows, groups } = await planBorrowedReprice({ ...params, apply: true });
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  params.ledger.setMeta(
    REPRICE_BORROWED_META_KEY,
    JSON.stringify({
      at: Date.now(),
      rows,
      groups: groups.map((g) => ({
        ...g,
        oldTotal: round(g.oldTotal),
        newTotal: round(g.newTotal),
      })),
    }),
  );
  if (rows > 0) {
    const detail = groups
      .map(
        (g) =>
          `${g.provider}/${g.model} x${g.rows} $${g.oldTotal.toFixed(4)} -> $${g.newTotal.toFixed(4)}`,
      )
      .join(", ");
    log.info(
      `usage reprice: ${rows} rows moved from a borrowed price to the live price: ${detail}`,
    );
  }
  return { ran: true, rows, groups };
}
