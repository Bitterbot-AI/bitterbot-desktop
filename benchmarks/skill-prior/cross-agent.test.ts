import { describe, expect, it } from "vitest";
import {
  type ArmInputs,
  cardLines,
  cellContrast,
  type EvalRow,
  exportCardBundle,
  flips,
  generateKeyPair,
  importCardBundle,
  liarRecords,
  originOf,
  poolRecords,
  referencePick,
  runGate,
  viewFor,
  XA_ARMS,
} from "./cross-agent.js";

const V = ["xp-f-a", "xp-f-b", "xp-f-c", "xp-f-d"];
const SKILLS = Object.fromEntries(V.map((v) => [v, `hash-${v}`]));

describe("card bundles", () => {
  const key = generateKeyPair();
  const cells = {
    "alder:f": { "xp-f-a": { passed: 0, runs: 1 }, "xp-f-b": { passed: 1, runs: 1 } },
    "birch:f": { "xp-f-c": { passed: 0, runs: 0 } },
  };
  const bundle = exportCardBundle({ key, model: "m", budget: 2, skills: SKILLS, cells });

  it("round-trips a signed bundle and omits empty cells and unused skills", () => {
    expect(Object.keys(bundle.cells)).toEqual(["alder:f"]);
    expect(Object.keys(bundle.skills).toSorted()).toEqual(["xp-f-a", "xp-f-b"]);
    const res = importCardBundle(JSON.parse(JSON.stringify(bundle)), { localSkills: SKILLS });
    expect(res).toMatchObject({ ok: true, origin: originOf(key), dropped: [] });
    expect(res.ok && res.cells["alder:f"]).toEqual(cells["alder:f"]);
  });

  it("refuses a tampered bundle", () => {
    const forged = JSON.parse(JSON.stringify(bundle));
    forged.cells["alder:f"]["xp-f-a"].passed = 1;
    expect(importCardBundle(forged, { localSkills: SKILLS })).toEqual({
      ok: false,
      reason: "bad signature",
    });
  });

  it("refuses an origin the recipient does not trust", () => {
    const other = generateKeyPair();
    expect(
      importCardBundle(bundle, {
        localSkills: SKILLS,
        trustedOrigins: new Set([originOf(other)]),
      }),
    ).toEqual({ ok: false, reason: "origin not trusted" });
  });

  it("refuses claims beyond the budget, even when signed", () => {
    const greedy = exportCardBundle({
      key,
      model: "m",
      budget: 2,
      skills: SKILLS,
      cells: { "alder:f": { "xp-f-a": { passed: 9, runs: 9 } } },
    });
    const res = importCardBundle(greedy, { localSkills: SKILLS });
    expect(res.ok).toBe(false);
    const inflated = exportCardBundle({
      key,
      model: "m",
      budget: 50,
      skills: SKILLS,
      cells: { "alder:f": { "xp-f-a": { passed: 9, runs: 9 } } },
    });
    expect(importCardBundle(inflated, { localSkills: SKILLS, maxBudget: 2 }).ok).toBe(false);
  });

  it("drops records about a skill whose content differs locally", () => {
    const res = importCardBundle(bundle, {
      localSkills: { ...SKILLS, "xp-f-b": "edited" },
    });
    expect(res.ok && res.dropped).toEqual(["alder:f/xp-f-b"]);
    expect(res.ok && Object.keys(res.cells["alder:f"]!)).toEqual(["xp-f-a"]);
  });

  it("rejects malformed input", () => {
    expect(importCardBundle(null, { localSkills: SKILLS }).ok).toBe(false);
    expect(importCardBundle({ protocol: "x" }, { localSkills: SKILLS }).ok).toBe(false);
  });
});

describe("pooling and card lines", () => {
  it("sums counts and counts contributing agents", () => {
    const p = poolRecords([
      { "xp-f-a": { passed: 0, runs: 1 } },
      {},
      { "xp-f-a": { passed: 1, runs: 1 }, "xp-f-b": { passed: 0, runs: 1 } },
    ]);
    expect(p.agents).toBe(2);
    expect(p.records).toEqual({
      "xp-f-a": { passed: 1, runs: 2 },
      "xp-f-b": { passed: 0, runs: 1 },
    });
  });

  it("shows nothing without records and a line on every variant with them", () => {
    expect(cardLines({}, V)).toEqual({});
    expect(cardLines({ own: {} }, V)).toEqual({});
    const lines = cardLines(
      {
        own: { "xp-f-a": { passed: 0, runs: 1 } },
        peer: { records: { "xp-f-b": { passed: 2, runs: 2 } }, agents: 2 },
      },
      V,
    );
    expect(Object.keys(lines)).toEqual(V);
    expect(lines["xp-f-a"]).toBe(
      "Your own runs here: REJECTED every time it was used (1 use). Runs here by 2 other agents: not tried yet.",
    );
    expect(lines["xp-f-b"]).toContain("Runs here by 2 other agents: ACCEPTED every time");
    expect(lines["xp-f-c"]).toContain("Your own runs here: not tried yet.");
  });

  it("placebo lines carry usage and no outcome", () => {
    const lines = cardLines(
      {
        peer: { records: { "xp-f-b": { passed: 2, runs: 2 } }, agents: 1 },
        peerUsageOnly: true,
      },
      V,
    );
    expect(lines["xp-f-b"]).toBe("Runs here by 1 other agent: 2 runs logged.");
    expect(Object.values(lines).join(" ")).not.toMatch(/ACCEPTED|REJECTED/);
  });
});

describe("arms", () => {
  const x: ArmInputs = {
    ownHalf: { "xp-f-b": { passed: 0, runs: 1 } },
    own: { "xp-f-b": { passed: 0, runs: 1 }, "xp-f-c": { passed: 0, runs: 1 } },
    donors: [
      { "xp-f-a": { passed: 1, runs: 1 }, "xp-f-d": { passed: 0, runs: 1 } },
      { "xp-f-a": { passed: 2, runs: 2 } },
      { "xp-f-b": { passed: 0, runs: 2 } },
    ],
    staleDonors: [{ "xp-f-c": { passed: 2, runs: 2 } }, {}, {}],
    correct: "xp-f-a",
    decoys: ["xp-f-b", "xp-f-c", "xp-f-d"],
    budget: 2,
    seed: "alder:f",
  };

  it("every arm yields a view, and peer1 uses the first donor only", () => {
    for (const arm of XA_ARMS) {
      expect(viewFor(arm, x)).toBeTypeOf("object");
    }
    expect(viewFor("none", x)).toEqual({});
    expect(viewFor("peer1", x).peer).toEqual({ records: x.donors[0], agents: 1 });
    expect(viewFor("peer", x).peer!.agents).toBe(3);
    expect(viewFor("own+peer", x).own).toBe(x.own);
    expect(viewFor("placebo", x).peerUsageOnly).toBe(true);
  });

  it("the liar stays inside its budget and replaces exactly one donor", () => {
    const lie = liarRecords(x.correct, x.decoys, 2, x.seed);
    expect(Object.values(lie).reduce((s, e) => s + e.runs, 0)).toBe(2);
    expect(lie[x.correct]).toEqual({ passed: 0, runs: 1 });
    expect(Object.values(liarRecords(x.correct, x.decoys, 1, x.seed))).toEqual([
      { passed: 1, runs: 1 },
    ]);
    const honest = viewFor("peer", x).peer!.records;
    const lied = viewFor("peer-liar", x).peer!.records;
    expect(lied).not.toEqual(honest);
    expect(viewFor("peer-liar", x)).toEqual(viewFor("peer-liar", x));
  });

  it("stale and oracle arms show what they should", () => {
    expect(viewFor("stale", x).peer!.records).toEqual({ "xp-f-c": { passed: 2, runs: 2 } });
    const oracle = viewFor("oracle", x).peer!.records;
    expect(oracle["xp-f-a"]).toEqual({ passed: 2, runs: 2 });
    expect(oracle["xp-f-b"]).toEqual({ passed: 0, runs: 2 });
  });

  it("the reference reader follows accepted records, then untried variants", () => {
    expect(referencePick({}, V)).toEqual(Object.fromEntries(V.map((v) => [v, 0.25])));
    expect(referencePick(viewFor("own", x), V)).toMatchObject({ "xp-f-a": 0.5, "xp-f-d": 0.5 });
    expect(referencePick(viewFor("peer", x), V)["xp-f-a"]).toBe(1);
    expect(referencePick(viewFor("own+peer", x), V)["xp-f-a"]).toBe(1);
    expect(referencePick(viewFor("stale", x), V)["xp-f-a"]).toBe(0);
    // A usage-only line carries nothing to follow.
    expect(referencePick(viewFor("placebo", x), V)["xp-f-a"]).toBe(0.25);
    const allRejected = {
      own: Object.fromEntries(V.map((v, i) => [v, { passed: 0, runs: i + 1 }])),
    };
    expect(referencePick(allRejected, V)["xp-f-a"]).toBe(1);
  });
});

describe("cell-level analysis", () => {
  const FAMS = ["f1", "f2", "f3"];
  const ENV = ["alder", "birch", "cedar", "elm"];
  /** Two tasks per cell; `passOf` gives each arm's pass per cell index. */
  const rowsFor = (passOf: Record<string, (i: number) => number>): EvalRow[] => {
    const rows: EvalRow[] = [];
    let i = 0;
    for (const family of FAMS) {
      for (const env of ENV) {
        for (const arm of Object.keys(passOf)) {
          for (const t of [0, 1]) {
            rows.push({
              arm,
              cell: `${env}:${family}`,
              family,
              taskId: `${env}-${family}-${t}`,
              pass: passOf[arm]!(i),
            });
          }
        }
        i++;
      }
    }
    return rows;
  };

  it("contrasts are computed per cell, not per task", () => {
    const rows = rowsFor({ peer: () => 1, own: (i) => (i % 2 === 0 ? 1 : 0) });
    const c = cellContrast(rows, "peer minus own", [
      ["peer", 1],
      ["own", -1],
    ]);
    expect(c.n).toBe(12);
    expect(c.mean).toBeCloseTo(0.5);
    expect([c.wins, c.losses, c.ties]).toEqual([6, 0, 6]);
    expect(c.p).toBeCloseTo(0.5 ** 6);
    expect(c.lo!).toBeGreaterThan(0);
  });

  it("supports a difference in differences and a cell filter", () => {
    const rows = rowsFor({
      none: () => 0,
      peer: () => 1,
      own: () => 1,
      "own+peer": () => 1,
    });
    const did = cellContrast(rows, "coverage", [
      ["peer", 1],
      ["none", -1],
      ["own+peer", -1],
      ["own", 1],
    ]);
    expect(did.mean).toBeCloseTo(1);
    const only = cellContrast(
      rows,
      "subset",
      [
        ["peer", 1],
        ["none", -1],
      ],
      new Set(["alder:f1", "birch:f1"]),
    );
    expect(only.n).toBe(2);
    expect(cellContrast(rows, "missing", [["nope", 1]]).n).toBe(0);
  });

  it("counts flips per task", () => {
    const rows = rowsFor({ a: (i) => (i < 4 ? 1 : 0), b: (i) => (i >= 2 && i < 6 ? 1 : 0) });
    expect(flips(rows, "a", "b")).toEqual({ up: 4, down: 4, same: 16 });
  });

  it("the gate confirms in order and turns exploratory after the first failure", () => {
    const strong = rowsFor({
      none: () => 0,
      placebo: () => 0,
      own: (i) => (i % 2 === 0 ? 1 : 0),
      peer: () => 1,
      "own+peer": () => 1,
      "peer-liar": () => 1,
    });
    const ok = runGate(strong);
    expect(ok.map((g) => g.id)).toEqual(["primary", "content", "coverage", "liar"]);
    expect(ok.every((g) => g.passed && g.confirmatory)).toBe(true);

    const nullPrimary = rowsFor({
      none: () => 0,
      placebo: () => 0,
      own: () => 1,
      peer: () => 1,
      "own+peer": () => 1,
      "peer-liar": () => 1,
    });
    const g = runGate(nullPrimary);
    expect(g[0]).toMatchObject({ passed: false, confirmatory: true });
    // Later steps may meet their criterion, but they are no longer confirmatory.
    expect(g[1]).toMatchObject({ passed: true, confirmatory: false });
    expect(g.slice(1).every((s) => !s.confirmatory)).toBe(true);
  });
});
