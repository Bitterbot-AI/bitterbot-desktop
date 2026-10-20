import type { BitterbotConfig } from "bitterbot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { XConfigSchema } from "./config-schema.js";
import {
  DEFAULT_POLICY,
  getAccountConfig,
  listAccountIds,
  normalizeHandle,
  resolvePolicy,
} from "./config.js";

describe("x config", () => {
  it("resolves the implicit default account from base-level fields", () => {
    const cfg = {
      channels: { x: { clientId: "abc", handle: "@BitterbotAI", policy: { maxPostsPerDay: 2 } } },
    } as unknown as BitterbotConfig;
    expect(listAccountIds(cfg)).toEqual(["default"]);
    const account = getAccountConfig(cfg, "default");
    expect(account?.clientId).toBe("abc");
    expect(resolvePolicy(account)).toEqual({ ...DEFAULT_POLICY, maxPostsPerDay: 2 });
    expect(normalizeHandle(account?.handle)).toBe("bitterbotai");
  });

  it("resolves named accounts and applies the channel-level kill switch", () => {
    const cfg = {
      channels: {
        x: {
          enabled: false,
          accounts: { dreams: { clientId: "d1" }, ops: { clientId: "o1", enabled: true } },
        },
      },
    } as unknown as BitterbotConfig;
    expect(listAccountIds(cfg).sort()).toEqual(["dreams", "ops"]);
    expect(getAccountConfig(cfg, "ops")?.enabled).toBe(false);
    expect(getAccountConfig(cfg, "missing")).toBeNull();
    expect(getAccountConfig({}, "default")).toBeNull();
  });

  it("schema rejects unknown keys and bad handles", () => {
    expect(XConfigSchema.safeParse({ clientId: "abc" }).success).toBe(true);
    expect(XConfigSchema.safeParse({ clientId: "abc", accessToken: "nope" }).success).toBe(false);
    expect(
      XConfigSchema.safeParse({ clientId: "abc", handle: "way-too-long-handle-here" }).success,
    ).toBe(false);
    expect(XConfigSchema.safeParse({ accounts: {} }).success).toBe(false);
  });
});
