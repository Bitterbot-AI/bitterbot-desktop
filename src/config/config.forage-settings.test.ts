import { describe, expect, it } from "vitest";
import { BitterbotSchema } from "./zod-schema.js";

// PLAN-29/PLAN-30: the forage config block. Strict objects — unknown keys
// are config typos and must fail loudly, since every key here is a money
// or integrity switch (audit kill switch, treasury list, earn caps).

describe("forage config schema", () => {
  it("accepts the full PLAN-29 + PLAN-30 forage block", () => {
    const result = BitterbotSchema.safeParse({
      forage: {
        nightShift: { enabled: true, maxConcurrentHunts: 4, maxRewardUsdc: 5 },
        pools: { enabled: false },
        audit: { enabled: true },
        genesis: {
          treasuryWallets: ["0x1593000000000000000000000000000000000000"],
          maxDailyTreasuryUsdcPerHunter: 0.5,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys in every forage sub-object (strict)", () => {
    for (const bad of [
      { forage: { audit: { enabled: true, rate: 0.5 } } },
      { forage: { genesis: { treasuryWallets: [], dailyCap: 1 } } },
      { forage: { nightShift: { enable: true } } },
      { forage: { seedVolume: 5000 } },
    ]) {
      expect(BitterbotSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects non-positive treasury caps", () => {
    const result = BitterbotSchema.safeParse({
      forage: { genesis: { maxDailyTreasuryUsdcPerHunter: 0 } },
    });
    expect(result.success).toBe(false);
  });
});
