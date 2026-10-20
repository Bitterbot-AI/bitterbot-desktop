import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveSpendGrantDb } from "./spend-grants.js";

describe("resolveSpendGrantDb", () => {
  it("uses the memory DB even when the marketplace is disabled (V1 default)", () => {
    const db = new DatabaseSync(":memory:");
    const manager = { getPaymentsDb: () => db, getMarketplaceEconomics: () => null };
    expect(resolveSpendGrantDb(manager)).toBe(db);
  });

  it("falls back to the marketplace economics handle on older managers", () => {
    const db = new DatabaseSync(":memory:");
    const manager = { getMarketplaceEconomics: () => ({ getDb: () => db }) };
    expect(resolveSpendGrantDb(manager)).toBe(db);
  });

  it("returns undefined only when neither handle exists", () => {
    expect(resolveSpendGrantDb({ getMarketplaceEconomics: () => null })).toBeUndefined();
  });
});
