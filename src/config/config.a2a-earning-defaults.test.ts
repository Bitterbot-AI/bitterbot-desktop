import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "./types.bitterbot.js";
import { applyA2aDefaults, isEarningCapable } from "./defaults.js";

// PLAN-29 Phase 0.2: the earning path (charging peers x402 USDC over A2A)
// defaults ON when the node holds full CDP credentials, OFF otherwise, and
// explicit config always wins. A wrong default here either silently disables
// the entire bounty economy (stuck OFF) or 402-walls wallet-less nodes'
// inbound A2A (stuck ON), so both directions are pinned.

const CDP_ENV_KEYS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CDP_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CDP_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setCdpEnv() {
  process.env.CDP_API_KEY_ID = "test-key-id";
  process.env.CDP_API_KEY_SECRET = "test-key-secret";
  process.env.CDP_WALLET_SECRET = "test-wallet-secret";
}

describe("isEarningCapable", () => {
  it("is false with no credentials anywhere", () => {
    expect(isEarningCapable({} as BitterbotConfig)).toBe(false);
  });

  it("is true with full CDP env credentials", () => {
    setCdpEnv();
    expect(isEarningCapable({} as BitterbotConfig)).toBe(true);
  });

  it("is false when any of the three credentials is missing", () => {
    setCdpEnv();
    delete process.env.CDP_WALLET_SECRET;
    expect(isEarningCapable({} as BitterbotConfig)).toBe(false);
  });

  it("accepts config-supplied API credentials (wallet secret stays env-only)", () => {
    process.env.CDP_WALLET_SECRET = "test-wallet-secret";
    const cfg = {
      tools: { wallet: { cdpApiKeyId: "cfg-id", cdpApiKeySecret: "cfg-secret" } },
    } as BitterbotConfig;
    expect(isEarningCapable(cfg)).toBe(true);
  });

  it("is false when the wallet is explicitly disabled, even with credentials", () => {
    setCdpEnv();
    const cfg = { tools: { wallet: { enabled: false } } } as BitterbotConfig;
    expect(isEarningCapable(cfg)).toBe(false);
  });
});

describe("applyA2aDefaults payment gate", () => {
  it("defaults payment.enabled=true for an earning-capable node", () => {
    setCdpEnv();
    const out = applyA2aDefaults({} as BitterbotConfig);
    expect(out.a2a?.payment?.enabled).toBe(true);
  });

  it("defaults payment.enabled=false without credentials", () => {
    const out = applyA2aDefaults({} as BitterbotConfig);
    expect(out.a2a?.payment?.enabled).toBe(false);
  });

  it("respects explicit payment.enabled=false despite credentials", () => {
    setCdpEnv();
    const out = applyA2aDefaults({
      a2a: { payment: { enabled: false } },
    } as BitterbotConfig);
    expect(out.a2a?.payment?.enabled).toBe(false);
  });

  it("respects explicit payment.enabled=true without credentials", () => {
    const out = applyA2aDefaults({
      a2a: { payment: { enabled: true } },
    } as BitterbotConfig);
    expect(out.a2a?.payment?.enabled).toBe(true);
  });

  it("keeps the derived default when other payment fields are configured", () => {
    setCdpEnv();
    const out = applyA2aDefaults({
      a2a: { payment: { x402: { minPayment: 0.05 } } },
    } as BitterbotConfig);
    expect(out.a2a?.payment?.enabled).toBe(true);
    expect(out.a2a?.payment?.x402?.minPayment).toBe(0.05);
  });
});

// PLAN-43 Phase 0: skill advertising on the public agent card is opt-in.
// The defaulted config is what the gateway hands to buildAgentCard, so the
// implication must be computed HERE — a card-side fallback never sees an
// unset `expose` once defaults ran.
describe("applyA2aDefaults skills.expose (PLAN-43 Phase 0)", () => {
  it("defaults expose to none", () => {
    const cfg = applyA2aDefaults({ a2a: { enabled: true } } as BitterbotConfig);
    expect(cfg.a2a?.skills?.expose).toBe("none");
  });

  it("an allowlist without expose implies exposure", () => {
    const cfg = applyA2aDefaults({
      a2a: { enabled: true, skills: { allowlist: ["summarize-webpage"] } },
    } as BitterbotConfig);
    expect(cfg.a2a?.skills?.expose).toBe("all");
    expect(cfg.a2a?.skills?.allowlist).toEqual(["summarize-webpage"]);
  });

  it("explicit expose always wins over the allowlist implication", () => {
    const cfg = applyA2aDefaults({
      a2a: { enabled: true, skills: { expose: "none", allowlist: ["x"] } },
    } as BitterbotConfig);
    expect(cfg.a2a?.skills?.expose).toBe("none");
  });
});
