import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The registry is mocked: claude-fable-5-1 / claude-opus-5-5 / claude-x-9 are forward-compat
// clones that borrowed Opus 4.7's $5/$25 price; claude-haiku-4-5 is a real vendored entry.
vi.mock("../agents/embedded-runner/model.js", () => {
  const opus47 = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const models: Record<string, { cost: typeof opus47; pricingBorrowedFrom?: string }> = {
    "anthropic/claude-fable-5-1": { cost: opus47, pricingBorrowedFrom: "claude-opus-4-7" },
    "anthropic/claude-opus-5-5": { cost: opus47, pricingBorrowedFrom: "claude-opus-4-7" },
    "anthropic/claude-x-9": { cost: opus47, pricingBorrowedFrom: "claude-opus-4-7" },
    "anthropic/claude-haiku-4-5": {
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  };
  return {
    resolveModel: (provider: string, model: string) => {
      const entry = models[`${provider}/${model}`];
      return entry ? { model: { id: model, provider, ...entry } } : { error: "Unknown model" };
    },
  };
});

import type { BitterbotConfig } from "../config/config.js";
import { setPricingSnapshotsForTest, type PricingSnapshot } from "./model-pricing-live.js";
import { resetModelPricingMemoForTest, resolveModelPricing } from "./model-pricing.js";
import { UsageLedger, resolveUsageEvent, type UsageEventInput } from "./usage-ledger.js";
import {
  planBorrowedReprice,
  REPRICE_BORROWED_META_KEY,
  repriceBorrowedRows,
  type VendoredCatalogCheck,
} from "./usage-reprice.js";

const cfg = {} as BitterbotConfig;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10);

function snapshot(fetchedAt: number, entries: PricingSnapshot["entries"]): PricingSnapshot {
  return { source: "openrouter", fetchedAt, entries };
}

const FABLE_LIVE = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 };
const OPUS55_LIVE = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };

function turn(model: string, extra: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    ts: T0 + DAY,
    kind: "chat",
    feature: "agent/turn",
    provider: "anthropic",
    model,
    usage: { input: 1000, output: 1000 },
    // What the library reports: computed from the cloned (borrowed) price.
    cost: { input: 0.005, output: 0.025, total: 0.03 },
    config: cfg,
    ...extra,
  };
}

beforeEach(() => {
  resetModelPricingMemoForTest();
});
afterEach(() => {
  setPricingSnapshotsForTest([]);
  resetModelPricingMemoForTest();
});

describe("borrowed forward-compat prices", () => {
  it("prefers the exact live entry over the borrowed catalog price", async () => {
    setPricingSnapshotsForTest([snapshot(T0, { "anthropic/claude-fable-5-1": FABLE_LIVE })]);
    const live = await resolveModelPricing({
      provider: "anthropic",
      model: "claude-fable-5-1",
      ts: T0 + DAY,
      cfg,
    });
    expect(live.source).toBe("live");
    expect(live.price.input).toBe(10);
    expect(live.borrowedFrom).toBe("claude-opus-4-7");
  });

  it("labels the borrowed price estimated when no exact entry exists (no fuzzy match)", async () => {
    // A near neighbour (claude-opus-5) must never price claude-opus-5-5.
    setPricingSnapshotsForTest([
      snapshot(T0, { "anthropic/claude-opus-5": { ...OPUS55_LIVE, input: 99 } }),
    ]);
    const est = await resolveModelPricing({
      provider: "anthropic",
      model: "claude-opus-5-5",
      ts: T0 + DAY,
      cfg,
    });
    expect(est.source).toBe("estimated");
    expect(est.price.input).toBe(5);
  });

  it("keeps the vendored catalog price for a real catalog entry even when live differs", async () => {
    setPricingSnapshotsForTest([
      snapshot(T0, { "anthropic/claude-haiku-4-5": { ...OPUS55_LIVE, input: 42 } }),
    ]);
    const cat = await resolveModelPricing({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      cfg,
    });
    expect(cat.source).toBe("catalog");
    expect(cat.price.input).toBe(1);
    expect(cat.borrowedFrom).toBeUndefined();
  });

  it("records a borrowed-price runner turn at the live price in force at the call", async () => {
    setPricingSnapshotsForTest([
      snapshot(T0, { "anthropic/claude-fable-5-1": { ...FABLE_LIVE, input: 8 } }),
      snapshot(T0 + 2 * DAY, { "anthropic/claude-fable-5-1": FABLE_LIVE }),
    ]);
    const early = await resolveUsageEvent(turn("claude-fable-5-1"));
    expect(early?.costSource).toBe("live");
    // 1000 in @ $8 + 1000 out @ $50 per M (the snapshot in force at T0 + 1d).
    expect(early?.cost.total).toBeCloseTo(0.058, 9);
    expect(early?.price?.input).toBe(8);
    resetModelPricingMemoForTest();
    const late = await resolveUsageEvent(turn("claude-fable-5-1", { ts: T0 + 3 * DAY }));
    expect(late?.cost.total).toBeCloseTo(0.06, 9);
  });

  it("keeps the reported cost but marks it estimated without an exact entry", async () => {
    setPricingSnapshotsForTest([snapshot(T0, { "anthropic/claude-fable-5-1": FABLE_LIVE })]);
    const row = await resolveUsageEvent(turn("claude-x-9"));
    expect(row?.costSource).toBe("estimated");
    expect(row?.cost.total).toBeCloseTo(0.03, 9);
  });

  it("leaves a vendored model's reported cost as provider", async () => {
    setPricingSnapshotsForTest([snapshot(T0, { "anthropic/claude-haiku-4-5": OPUS55_LIVE })]);
    const row = await resolveUsageEvent(turn("claude-haiku-4-5"));
    expect(row?.costSource).toBe("provider");
    expect(row?.cost.total).toBeCloseTo(0.03, 9);
  });
});

describe("reprice:borrowed:v1 correction", () => {
  let ledger: UsageLedger;
  const isVendored: VendoredCatalogCheck = (provider, model) =>
    provider === "anthropic" ? model === "claude-haiku-4-5" : null;

  /** Insert a row as the old ledger wrote it: library cost, source "provider". */
  async function oldRow(model: string, extra: Partial<UsageEventInput> = {}) {
    const resolved = await resolveUsageEvent(turn("claude-haiku-4-5", extra));
    const id = ledger.insert({ ...resolved!, model, costSource: "provider" });
    expect(id).not.toBeNull();
    return id!;
  }

  beforeEach(() => {
    ledger = UsageLedger.openInMemory();
  });
  afterEach(() => {
    ledger.close();
  });

  it("re-prices only borrowed provider rows at the snapshot in force, once", async () => {
    // Rows are written before any snapshot exists, so nothing reprices them at insert time.
    setPricingSnapshotsForTest([]);
    const fableEarly = await oldRow("claude-fable-5-1", { ts: T0 + DAY });
    const fableLate = await oldRow("claude-fable-5-1", { ts: T0 + 3 * DAY });
    const opus = await oldRow("claude-opus-5-5", { ts: T0 + 3 * DAY });
    const vendored = await oldRow("claude-haiku-4-5", { ts: T0 + 3 * DAY });
    const notInSnapshot = await oldRow("claude-x-9", { ts: T0 + 3 * DAY });
    const estimatedSource = ledger.insert({
      ...(await resolveUsageEvent(turn("claude-haiku-4-5")))!,
      model: "claude-fable-5-1",
      costSource: "estimated",
    })!;
    const overridden = await oldRow("claude-custom-1", { ts: T0 + 3 * DAY });
    const cfgOverride = {
      models: { providers: { anthropic: { models: [{ id: "claude-custom-1" }] } } },
    } as unknown as BitterbotConfig;

    // Not marked done while no snapshot is loaded.
    expect((await repriceBorrowedRows({ ledger, cfg: cfgOverride, isVendored })).reason).toBe(
      "no-snapshots",
    );
    expect(ledger.getMeta(REPRICE_BORROWED_META_KEY)).toBeNull();

    setPricingSnapshotsForTest([
      snapshot(T0, {
        "anthropic/claude-fable-5-1": { ...FABLE_LIVE, input: 8 },
        "anthropic/claude-haiku-4-5": { ...OPUS55_LIVE, input: 42 },
        "anthropic/claude-custom-1": { ...OPUS55_LIVE, input: 42 },
      }),
      snapshot(T0 + 2 * DAY, {
        "anthropic/claude-fable-5-1": FABLE_LIVE,
        "anthropic/claude-opus-5-5": OPUS55_LIVE,
        "anthropic/claude-haiku-4-5": { ...OPUS55_LIVE, input: 42 },
        "anthropic/claude-custom-1": { ...OPUS55_LIVE, input: 42 },
      }),
    ]);
    const dry = await planBorrowedReprice({ ledger, cfg: cfgOverride, isVendored });
    expect(dry.rows).toBe(3);
    expect(ledger.getMeta(REPRICE_BORROWED_META_KEY)).toBeNull();

    const res = await repriceBorrowedRows({ ledger, cfg: cfgOverride, isVendored });
    expect(res.ran).toBe(true);
    expect(res.rows).toBe(3);
    const byId = new Map(ledger.events({ limit: 50 }).events.map((e) => [e.id, e]));
    expect(byId.get(fableEarly)?.costSource).toBe("live");
    expect(byId.get(fableEarly)?.cost.total).toBeCloseTo(0.058, 9);
    expect(byId.get(fableLate)?.cost.total).toBeCloseTo(0.06, 9);
    expect(byId.get(fableLate)?.price?.output).toBe(50);
    expect(byId.get(fableLate)?.costComputed).toBeCloseTo(0.06, 9);
    expect(byId.get(opus)?.cost.total).toBeCloseTo(0.024, 9);
    for (const untouched of [vendored, notInSnapshot, overridden]) {
      expect(byId.get(untouched)?.costSource).toBe("provider");
      expect(byId.get(untouched)?.cost.total).toBeCloseTo(0.03, 9);
    }
    expect(byId.get(estimatedSource)?.costSource).toBe("estimated");
    expect(ledger.count()).toBe(7);

    const meta = JSON.parse(ledger.getMeta(REPRICE_BORROWED_META_KEY) ?? "{}") as {
      rows: number;
      groups: Array<{ model: string; rows: number; oldTotal: number; newTotal: number }>;
    };
    expect(meta.rows).toBe(3);
    expect(meta.groups.find((g) => g.model === "claude-fable-5-1")).toMatchObject({
      rows: 2,
      oldTotal: 0.06,
      newTotal: 0.118,
    });

    // Idempotent: a second boot does nothing.
    const again = await repriceBorrowedRows({ ledger, cfg: cfgOverride, isVendored });
    expect(again).toMatchObject({ ran: false, reason: "already-ran", rows: 0 });
    expect(ledger.events({ limit: 50 }).events.find((e) => e.id === fableLate)?.cost.total).toBe(
      byId.get(fableLate)?.cost.total,
    );
  });
});
