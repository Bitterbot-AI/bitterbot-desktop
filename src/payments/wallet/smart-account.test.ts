/**
 * PLAN-48 Phase 4 scaffold: the pure half of the CDP Smart Account upgrade —
 * the spend-permission descriptor and the I5 address/balance continuity check.
 * The live upgrade + routing is a Victor-run operator step and is not exercised
 * here.
 */
import { describe, expect, it } from "vitest";
import { assertAddressContinuity, buildSpendPermission, usdToBaseUnits } from "./smart-account.js";

const SMART = "0x00000000000000000000000000000000000000aa";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const EOA = "0x1593000000000000000000000000000000000000";

describe("buildSpendPermission", () => {
  it("derives base units + defaults from the allowance config", () => {
    const d = buildSpendPermission({ smartAccount: SMART, token: TOKEN, allowanceUsd: 5 });
    expect(d.allowance).toBe("5000000"); // 5 USDC in 6-decimal base units
    expect(d.period).toBe(86_400); // default daily
    expect(d.account).toBe(SMART); // lowercased
    expect(d.token).toBe(TOKEN.toLowerCase());
    expect(typeof d.start).toBe("number");
  });

  it("honors an explicit period and start anchor", () => {
    const d = buildSpendPermission({
      smartAccount: SMART,
      token: TOKEN,
      allowanceUsd: 1.5,
      periodSeconds: 3600,
      startSec: 1000,
    });
    expect(d.allowance).toBe("1500000");
    expect(d.period).toBe(3600);
    expect(d.start).toBe(1000);
  });

  it("rejects a bad address or period", () => {
    expect(() =>
      buildSpendPermission({ smartAccount: "nope", token: TOKEN, allowanceUsd: 1 }),
    ).toThrow(/0x address/);
    expect(() =>
      buildSpendPermission({
        smartAccount: SMART,
        token: TOKEN,
        allowanceUsd: 1,
        periodSeconds: 0,
      }),
    ).toThrow(/periodSeconds/);
  });

  it("usdToBaseUnits rounds to 6 decimals and rejects negatives", () => {
    expect(usdToBaseUnits(0.000001)).toBe("1");
    expect(usdToBaseUnits(0)).toBe("0");
    expect(() => usdToBaseUnits(-1)).toThrow(/invalid/);
  });
});

describe("assertAddressContinuity (I5)", () => {
  it("passes when the smart account is owned by the original EOA and balances hold", () => {
    const r = assertAddressContinuity({
      eoaAddress: EOA,
      smartAccountAddress: SMART,
      smartAccountOwner: EOA.toUpperCase(), // case-insensitive
      eoaUsdcBefore: 1_000_000n,
      eoaUsdcAfter: 1_000_000n,
    });
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("fails when the owner is not the original EOA", () => {
    const r = assertAddressContinuity({
      eoaAddress: EOA,
      smartAccountAddress: SMART,
      smartAccountOwner: "0x9999000000000000000000000000000000000000",
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/owner .* != original EOA/);
  });

  it("fails when the EOA balance was drained by the upgrade", () => {
    const r = assertAddressContinuity({
      eoaAddress: EOA,
      smartAccountAddress: SMART,
      smartAccountOwner: EOA,
      eoaUsdcBefore: 1_000_000n,
      eoaUsdcAfter: 0n,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/decreased/);
  });

  it("fails on a zero or malformed smart account address", () => {
    expect(
      assertAddressContinuity({
        eoaAddress: EOA,
        smartAccountAddress: "0x0000000000000000000000000000000000000000",
        smartAccountOwner: EOA,
      }).ok,
    ).toBe(false);
    expect(
      assertAddressContinuity({
        eoaAddress: EOA,
        smartAccountAddress: "0xnotanaddress",
        smartAccountOwner: EOA,
      }).ok,
    ).toBe(false);
  });
});
