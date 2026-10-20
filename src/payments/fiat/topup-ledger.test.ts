import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkFundingWithinCeiling } from "./funding-policy.js";
import { listTopUps, recordTopUp, sessionIdFromClientSecret } from "./topup-ledger.js";

const file = async () => path.join(await mkdtemp(path.join(tmpdir(), "topups-")), "topups.json");

describe("top-up ledger", () => {
  it("records a completed session once, however many times it is reported", async () => {
    const f = await file();
    const rec = { sessionId: "cos_1", amountUsd: 40, atMs: 1_000, source: "reported" as const };

    expect(await recordTopUp(f, rec)).toBe(true);
    expect(await recordTopUp(f, { ...rec, amountUsd: 999 })).toBe(false);
    expect(await listTopUps(f)).toEqual([rec]);
  });

  it("keeps concurrent reports of different sessions", async () => {
    const f = await file();
    await Promise.all(
      [1, 2, 3].map((n) =>
        recordTopUp(f, { sessionId: `cos_${n}`, amountUsd: n, atMs: n, source: "reported" }),
      ),
    );
    expect((await listTopUps(f)).map((r) => r.sessionId).toSorted()).toEqual([
      "cos_1",
      "cos_2",
      "cos_3",
    ]);
  });

  it("makes the monthly ceiling count what was already added", async () => {
    const f = await file();
    const now = Date.UTC(2026, 9, 6);
    await recordTopUp(f, {
      sessionId: "cos_a",
      amountUsd: 80,
      atMs: now - 86_400_000,
      source: "reported",
    });

    const check = checkFundingWithinCeiling({
      requestUsd: 30,
      ceilingUsd: 100,
      priorTopUps: await listTopUps(f),
      now,
    });

    expect(check.allowed).toBe(false);
    expect(check.remainingUsd).toBe(20);
  });

  it("reads the session id out of a client secret", () => {
    expect(sessionIdFromClientSecret("cos_1Abc_secret_xyz")).toBe("cos_1Abc");
    expect(sessionIdFromClientSecret("no-secret-here")).toBeNull();
  });
});
