import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autoScratchEventText,
  DreamGateState,
  evaluateDreamGate,
  HormonalDeltaTrigger,
  lastAutoScratchEvent,
} from "./dream-gate.js";

const H = 3_600_000;
const CFG = { minNewSessions: 1, minIdleMinutes: 60, minHoursBetween: 8 };

describe("evaluateDreamGate (scheduled full-cycle triple gate)", () => {
  const now = 100 * H;

  it("blocks when no new user turns arrived since the last full cycle", () => {
    const d = evaluateDreamGate(CFG, {
      now,
      newSessions: 0,
      lastUserTurnAt: now - 5 * H,
      lastFullCycleAt: now - 24 * H,
    });
    expect(d.pass).toBe(false);
    expect(d.reason).toContain("no new input");
  });

  it("blocks while the user was active within minIdleMinutes", () => {
    const d = evaluateDreamGate(CFG, {
      now,
      newSessions: 3,
      lastUserTurnAt: now - 10 * 60_000,
      lastFullCycleAt: now - 24 * H,
    });
    expect(d.pass).toBe(false);
    expect(d.reason).toContain("user active");
  });

  it("blocks when the last full cycle is more recent than minHoursBetween", () => {
    const d = evaluateDreamGate(CFG, {
      now,
      newSessions: 3,
      lastUserTurnAt: now - 2 * H,
      lastFullCycleAt: now - 3 * H,
    });
    expect(d.pass).toBe(false);
    expect(d.reason).toContain("last full cycle");
  });

  it("passes when all three hold", () => {
    const d = evaluateDreamGate(CFG, {
      now,
      newSessions: 1,
      lastUserTurnAt: now - 2 * H,
      lastFullCycleAt: now - 9 * H,
    });
    expect(d.pass).toBe(true);
  });

  it("treats unknown timestamps (0) as satisfied so a fresh node can dream once input exists", () => {
    expect(
      evaluateDreamGate(CFG, { now, newSessions: 1, lastUserTurnAt: 0, lastFullCycleAt: 0 }).pass,
    ).toBe(true);
  });

  it("an idle day with no user turns never passes, whatever the cadence", () => {
    for (let h = 0; h < 24; h += 4) {
      const t = now + h * H;
      expect(
        evaluateDreamGate(CFG, {
          now: t,
          newSessions: 0,
          lastUserTurnAt: now - 30 * H,
          lastFullCycleAt: now - 30 * H,
        }).pass,
      ).toBe(false);
    }
  });
});

describe("DreamGateState (persisted counters)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("counts user turns, resets on a full cycle, survives a re-open of the state object", () => {
    const a = new DreamGateState(db);
    a.recordUserTurn(1_000);
    a.recordUserTurn(2_000);
    const b = new DreamGateState(db);
    expect(b.snapshot(5_000)).toEqual({
      now: 5_000,
      newSessions: 2,
      lastUserTurnAt: 2_000,
      lastFullCycleAt: 0,
    });
    b.recordFullCycle(6_000);
    expect(a.snapshot(7_000)).toMatchObject({ newSessions: 0, lastFullCycleAt: 6_000 });
  });

  it("discovery gate: counts skill chunks created since the last discovery run", () => {
    db.exec(
      `CREATE TABLE chunks (id TEXT PRIMARY KEY, memory_type TEXT, semantic_type TEXT, created_at INTEGER)`,
    );
    const state = new DreamGateState(db);
    db.prepare(`INSERT INTO chunks VALUES ('s1', 'skill', NULL, 1000)`).run();
    db.prepare(`INSERT INTO chunks VALUES ('f1', NULL, 'general', 1000)`).run();
    expect(state.newSkillChunksSinceDiscovery()).toBe(1);
    state.recordDiscoveryRun(2_000);
    expect(state.newSkillChunksSinceDiscovery()).toBe(0);
    db.prepare(`INSERT INTO chunks VALUES ('s2', NULL, 'skill', 3000)`).run();
    expect(state.newSkillChunksSinceDiscovery()).toBe(1);
  });

  it("discovery gate is safe without a chunks table", () => {
    expect(new DreamGateState(db).newSkillChunksSinceDiscovery()).toBe(0);
  });
});

describe("HormonalDeltaTrigger", () => {
  it("does not fire on the first observation or on a pinned high level", () => {
    const t = new HormonalDeltaTrigger(0.15);
    expect(t.check({ dopamine: 0.9, cortisol: 0.1, oxytocin: 0.1 })).toEqual([]);
    // 48 consolidation ticks at a pinned 0.9: zero mini-dreams.
    for (let i = 0; i < 48; i++) {
      expect(t.check({ dopamine: 0.9, cortisol: 0.1, oxytocin: 0.1 })).toEqual([]);
    }
  });

  it("fires once on a rise >= delta, then re-arms only after another rise", () => {
    const t = new HormonalDeltaTrigger(0.15);
    t.check({ dopamine: 0.5, cortisol: 0.1, oxytocin: 0.1 });
    expect(t.check({ dopamine: 0.7, cortisol: 0.1, oxytocin: 0.1 })).toEqual(["dopamine_spike"]);
    expect(t.check({ dopamine: 0.7, cortisol: 0.1, oxytocin: 0.1 })).toEqual([]);
    expect(t.check({ dopamine: 0.6, cortisol: 0.1, oxytocin: 0.1 })).toEqual([]);
    expect(t.check({ dopamine: 0.76, cortisol: 0.3, oxytocin: 0.1 })).toEqual([
      "dopamine_spike",
      "cortisol_spike",
    ]);
  });

  it("a rise below delta does not fire", () => {
    const t = new HormonalDeltaTrigger(0.15);
    t.check({ dopamine: 0.5, cortisol: 0.1, oxytocin: 0.1 });
    expect(t.check({ dopamine: 0.6, cortisol: 0.1, oxytocin: 0.24 })).toEqual([]);
  });
});

describe("auto-scratch dedupe", () => {
  it("finds the event of the most recent auto note", () => {
    const scratch = [
      "# Scratch Buffer",
      "",
      "- [2026-09-18T01:00:00Z] (importance: 0.8) [AUTO] Hormonal event: dopamine spike (achievement/breakthrough detected). Mood: elated.",
      "- [2026-09-18T01:30:00Z] user note about the deploy",
    ].join("\n");
    expect(lastAutoScratchEvent(scratch)).toBe(
      autoScratchEventText(["dopamine spike (achievement/breakthrough detected)"]),
    );
  });

  it("returns null when no auto note exists", () => {
    expect(lastAutoScratchEvent("# Scratch\n- [t] plain note\n")).toBeNull();
  });
});
