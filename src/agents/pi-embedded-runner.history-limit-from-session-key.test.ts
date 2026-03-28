import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { getDmHistoryLimitFromSessionKey } from "./pi-embedded-runner.js";

describe("getDmHistoryLimitFromSessionKey", () => {
  it("keeps backward compatibility for dm/direct session kinds", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10 } },
    } as BitterbotConfig;

    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(10);
    expect(getDmHistoryLimitFromSessionKey("telegram:direct:123", config)).toBe(10);
  });

  it("returns historyLimit for channel and group session kinds", () => {
    const config = {
      channels: { discord: { historyLimit: 12, dmHistoryLimit: 5 } },
    } as BitterbotConfig;

    expect(getDmHistoryLimitFromSessionKey("discord:channel:123", config)).toBe(12);
    expect(getDmHistoryLimitFromSessionKey("discord:group:456", config)).toBe(12);
  });

  it("returns undefined for unsupported session kinds", () => {
    const config = {
      channels: { discord: { historyLimit: 12, dmHistoryLimit: 5 } },
    } as BitterbotConfig;

    expect(getDmHistoryLimitFromSessionKey("discord:slash:123", config)).toBeUndefined();
  });
});
