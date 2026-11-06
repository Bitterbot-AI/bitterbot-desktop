import { describe, expect, it } from "vitest";
import {
  cellScores,
  creditedSkill,
  cumulativeRegret,
  type EpisodeTrace,
  learningCurve,
  lessonPrompt,
  recordsFrom,
  renderMemory,
  switchStats,
  thompsonPick,
  verbalRecord,
} from "./online.js";

const V = ["xp-f-a", "xp-f-b", "xp-f-c", "xp-f-d"];
const tr = (over: Partial<EpisodeTrace>): EpisodeTrace => ({
  episode: 0,
  skill: null,
  read: [],
  final: null,
  accepted: false,
  ...over,
});

describe("credit and records", () => {
  it("credits the last variant read and ignores fillers", () => {
    expect(creditedSkill(["xp-f-a", "xp-f-c", "xp-filler"], V)).toBe("xp-f-c");
    expect(creditedSkill(["xp-filler"], V)).toBeNull();
  });
  it("counts accepted runs per credited skill", () => {
    const r = recordsFrom(
      [tr({ skill: "xp-f-a" }), tr({ skill: "xp-f-b", accepted: true }), tr({ skill: null })],
      V,
    );
    expect(r["xp-f-a"]).toEqual({ passed: 0, runs: 1 });
    expect(r["xp-f-b"]).toEqual({ passed: 1, runs: 1 });
    expect(r["xp-f-d"]).toEqual({ passed: 0, runs: 0 });
  });
});

describe("renderMemory", () => {
  const traces = [
    tr({ episode: 0, skill: "xp-f-a", final: "12", lesson: "Avoid -a here." }),
    tr({ episode: 1, skill: "xp-f-b", final: "9", accepted: true, lesson: "Use -b." }),
  ];
  it("shows nothing cold, and nothing in the prompt for none, bandit or records-index", () => {
    expect(renderMemory("records", [], V)).toBeNull();
    for (const arm of ["none", "bandit", "records-index"] as const) {
      expect(renderMemory(arm, traces, V)).toBeNull();
    }
  });
  it("renders each format from the same history", () => {
    expect(renderMemory("records", traces, V)).toContain("- xp-f-b: 1 of 1 accepted");
    expect(renderMemory("records", traces, V)).not.toContain("Lessons");
    const ep = renderMemory("episodes", traces, V)!;
    expect(ep).toContain("Task 1: used xp-f-a, answered 12, REJECTED");
    expect(ep).toContain("Task 2: used xp-f-b, answered 9, ACCEPTED");
    const ls = renderMemory("lessons", traces, V)!;
    expect(ls).toContain("- Use -b.");
    expect(ls).not.toContain("accepted /");
    const both = renderMemory("records-lessons", traces, V)!;
    expect(both).toContain("1 of 1 accepted");
    expect(both).toContain("- Avoid -a here.");
  });
  it("confirmation formats carry the same history in other words", () => {
    const vb = renderMemory("records-verbal", traces, V)!;
    expect(vb).toContain("- xp-f-a: REJECTED every time it was used (1 use)");
    expect(vb).toContain("- xp-f-b: ACCEPTED every time it was used (1 use)");
    expect(vb).toContain("- xp-f-c: not tried yet");
    const na = renderMemory("episodes-noanswer", traces, V)!;
    expect(na).toContain("Task 1: used xp-f-a, REJECTED");
    expect(na).not.toContain("answered");
    expect(verbalRecord({ passed: 1, runs: 3 })).toBe("accepted 1 of 3 uses, rejected the rest");
  });
  it("the lesson writer sees the verdict and nothing else about truth", () => {
    const p = lessonPrompt({
      task: "T",
      read: ["xp-f-a"],
      final: "3",
      accepted: false,
      previous: [],
    });
    expect(p).toContain("REJECTED");
    expect(p).not.toMatch(/correct (skill|variant)/i);
  });
});

describe("thompsonPick", () => {
  it("is deterministic per seed and explores when cold", () => {
    const cold = Object.fromEntries(V.map((v) => [v, { passed: 0, runs: 0 }]));
    expect(thompsonPick(cold, V, "s1")).toBe(thompsonPick(cold, V, "s1"));
    const picks = new Set(Array.from({ length: 200 }, (_, i) => thompsonPick(cold, V, `s${i}`)));
    expect(picks.size).toBe(4);
  });
  it("exploits a clearly winning arm", () => {
    const rec = {
      "xp-f-a": { passed: 0, runs: 3 },
      "xp-f-b": { passed: 4, runs: 4 },
      "xp-f-c": { passed: 0, runs: 2 },
      "xp-f-d": { passed: 0, runs: 2 },
    };
    const wins = Array.from({ length: 400 }, (_, i) => thompsonPick(rec, V, `x${i}`)).filter(
      (p) => p === "xp-f-b",
    ).length;
    expect(wins / 400).toBeGreaterThan(0.8);
  });
});

describe("metrics", () => {
  const rows = [
    { cell: "a", family: "f", episode: 0, pass: 0 },
    { cell: "a", family: "f", episode: 1, pass: 1 },
    { cell: "a", family: "f", episode: 2, pass: 1 },
    { cell: "b", family: "f", episode: 0, pass: 1 },
    { cell: "b", family: "f", episode: 1, pass: 0 },
  ];
  it("learning curve and cell scores skip the cold episode", () => {
    expect(learningCurve(rows)).toEqual([
      { episode: 0, n: 2, pass: 0.5 },
      { episode: 1, n: 2, pass: 0.5 },
      { episode: 2, n: 1, pass: 1 },
    ]);
    const s = cellScores(rows);
    expect(s.get("a")).toBe(1);
    expect(s.get("b")).toBe(0);
  });
  it("regret is oracle minus achieved", () => {
    expect(cumulativeRegret(rows, { f: 0.9 })).toBeCloseTo(0.9 * 5 - 3);
  });
});

describe("switchStats", () => {
  it("counts stays after accepts and rejects separately", () => {
    const cell = [
      tr({ skill: "xp-f-a" }),
      tr({ skill: "xp-f-a" }),
      tr({ skill: "xp-f-b", accepted: true }),
      tr({ skill: "xp-f-b", accepted: true }),
    ];
    expect(switchStats([cell])).toEqual({
      afterAccept: { n: 1, stay: 1 },
      afterReject: { n: 2, stay: 1 },
    });
  });
});
