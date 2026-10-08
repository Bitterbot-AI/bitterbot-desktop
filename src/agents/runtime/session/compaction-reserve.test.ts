import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../../config/config.js";
import {
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
  resolveCompactionReserveTokensFloor,
} from "./compaction-reserve.js";

describe("resolveCompactionReserveTokensFloor", () => {
  it("returns the default when config is missing", () => {
    expect(resolveCompactionReserveTokensFloor(undefined)).toBe(
      DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
    expect(resolveCompactionReserveTokensFloor({} as BitterbotConfig)).toBe(
      DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
  });

  it("accepts configured floors, including zero, and floors fractions", () => {
    const cfg = (floor: unknown) =>
      ({ agents: { defaults: { compaction: { reserveTokensFloor: floor } } } }) as BitterbotConfig;
    expect(resolveCompactionReserveTokensFloor(cfg(0))).toBe(0);
    expect(resolveCompactionReserveTokensFloor(cfg(32_000.7))).toBe(32_000);
  });

  it("ignores negative, non-finite and non-numeric values", () => {
    const cfg = (floor: unknown) =>
      ({ agents: { defaults: { compaction: { reserveTokensFloor: floor } } } }) as BitterbotConfig;
    expect(resolveCompactionReserveTokensFloor(cfg(-1))).toBe(
      DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
    expect(resolveCompactionReserveTokensFloor(cfg(Number.NaN))).toBe(
      DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
    expect(resolveCompactionReserveTokensFloor(cfg("20000"))).toBe(
      DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
  });
});
