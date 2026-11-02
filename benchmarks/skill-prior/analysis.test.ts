import { describe, expect, it } from "vitest";
import { headroom, pairedContrast, readCorrect, summarizeArm } from "./analysis.js";
import type { TrialRecord } from "./executor.js";
import { poolByFamily } from "./pool.js";

function rec(
  over: Partial<TrialRecord> & { arm: string; taskId: string; family: string },
): TrialRecord {
  return {
    key: `${over.arm}|${over.taskId}|${over.trialIndex ?? 0}`,
    phase: "test",
    seed: 1,
    trialIndex: 0,
    indexOrder: [],
    pass: 0,
    read: [],
    tokensIn: 100,
    tokensOut: 10,
    cacheRead: 0,
    wallMs: 1,
    model: "anthropic/claude-haiku-4-5",
    error: null,
    runId: "r",
    ...over,
  };
}

describe("analysis", () => {
  const correct = poolByFamily("ledger-sum").correct.name;
  const decoy = poolByFamily("ledger-sum").decoy.name;

  it("credits a read of the family's correct skill only", () => {
    expect(readCorrect(rec({ arm: "a", taskId: "t", family: "ledger-sum", read: [correct] }))).toBe(
      1,
    );
    expect(readCorrect(rec({ arm: "a", taskId: "t", family: "ledger-sum", read: [decoy] }))).toBe(
      0,
    );
  });

  it("pairs by task instance and reports wins, losses and a CI", () => {
    const arm: TrialRecord[] = [];
    const base: TrialRecord[] = [];
    for (let i = 0; i < 12; i++) {
      const taskId = `t${i}`;
      arm.push(rec({ arm: "prior", taskId, family: "ledger-sum", pass: i < 9 ? 1 : 0 }));
      base.push(rec({ arm: "baseline", taskId, family: "ledger-sum", pass: i < 4 ? 1 : 0 }));
    }
    const c = pairedContrast(arm, base, "pass")!;
    expect(c.n).toBe(12);
    expect(c.wins).toBe(5);
    expect(c.losses).toBe(0);
    expect(c.meanDelta).toBeCloseTo(5 / 12);
    expect(c.ci95Low).toBeGreaterThan(0);
    expect(c.byFamily["ledger-sum"]).toBeCloseTo(5 / 12);
  });

  it("summarizes arms and computes headroom from the forced-skill table", () => {
    const rs: TrialRecord[] = [];
    for (let i = 0; i < 4; i++) {
      rs.push(rec({ arm: "none", taskId: `t${i}`, family: "ledger-sum", pass: i < 2 ? 1 : 0 }));
      rs.push(
        rec({
          arm: "correct",
          taskId: `t${i}`,
          family: "ledger-sum",
          pass: 1,
          indexOrder: [correct],
          read: [correct],
        }),
      );
      rs.push(
        rec({
          arm: "decoy",
          taskId: `t${i}`,
          family: "ledger-sum",
          pass: 0,
          indexOrder: [decoy],
          read: [decoy],
        }),
      );
    }
    const h = headroom(rs);
    expect(h.overall.headroom).toBeCloseTo(0.5);
    expect(h.overall.decoyHarm).toBeCloseTo(0.5);
    expect(h.globalOrder[0]!.skill).toBe(correct);
    const s = summarizeArm(rs.filter((r) => r.arm === "correct"))!;
    expect(s.readCorrect).toBe(1);
    expect(s.pass).toBe(1);
    expect(s.byFamily["ledger-sum"]!.trials).toBe(4);
  });
});
