/**
 * PLAN-48 Phase 4 scaffold: WalletService.getSmartAccountConfig surfaces the
 * intended spend-permission parameters (pure config echo — no CDP call, no
 * account creation). The live upgrade + routing is a Victor-run operator step.
 */
import { describe, expect, it } from "vitest";
import { createWalletService } from "./wallet-service.js";

describe("WalletService.getSmartAccountConfig", () => {
  it("reports disabled with sane defaults when smartAccount is unset", () => {
    const s = createWalletService({ network: "base" });
    const cfg = s.getSmartAccountConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.periodSeconds).toBe(86_400);
    expect(cfg.sponsorGas).toBe(false);
    expect(cfg.token).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); // USDC on base
    expect(cfg.network).toBe("base");
  });

  it("echoes the configured allowance/period/gas when enabled", () => {
    const s = createWalletService({
      network: "base-sepolia",
      smartAccount: { enabled: true, allowanceUsd: 5, periodSeconds: 3600, sponsorGas: true },
    });
    const cfg = s.getSmartAccountConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowanceUsd).toBe(5);
    expect(cfg.periodSeconds).toBe(3600);
    expect(cfg.sponsorGas).toBe(true);
    expect(cfg.token).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e"); // USDC on base-sepolia
  });
});
