import { describe, expect, it } from "vitest";
import {
  annotateSkillsPrompt,
  applySkillPrior,
  derange,
  formatSkillEvidence,
  verbalRecord,
  reorderSkillsPrompt,
  sampleBeta,
  skillOrderInPrompt,
  SkillPriorLedger,
} from "./skill-prior.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A = { name: "alpha", hash: "h-a" };
const B = { name: "bravo", hash: "h-b" };
const C = { name: "cedar", hash: "h-c" };

const PROMPT = [
  "The following skills provide specialized instructions for specific tasks.",
  "<available_skills>",
  "  <skill>",
  "    <name>alpha</name>",
  "    <description>A.</description>",
  "    <location>/s/alpha/SKILL.md</location>",
  "  </skill>",
  "  <skill>",
  "    <name>bravo</name>",
  "    <description>B.</description>",
  "    <location>/s/bravo/SKILL.md</location>",
  "  </skill>",
  "  <skill>",
  "    <name>cedar</name>",
  "    <description>C.</description>",
  "    <location>/s/cedar/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
  "",
].join("\n");

describe("SkillPriorLedger", () => {
  it("starts uninformative and keeps the incoming order on ties", () => {
    const ledger = new SkillPriorLedger();
    const r = ledger.order({ cell: "ledger", candidates: [A, B, C], mode: "mean" });
    expect(r.order).toEqual(["alpha", "bravo", "cedar"]);
    expect(r.means.alpha).toBeCloseTo(0.5);
  });

  it("gated updates move only the read skill, failures depress, and the mean step is (r - b)/(a+b+1)", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 1 });
    const before = ledger.mean("ledger", B);
    const u = ledger.update({ cell: "ledger", skill: B, outcome: 1, runId: "r1", gate: true });
    expect(u.applied).toBe(true);
    if (u.applied) {
      const p = ledger.posterior("ledger", B);
      expect(u.after - u.before).toBeCloseTo((1 - before) / (p.alpha + p.beta - 1 + 1));
    }
    expect(ledger.mean("ledger", A)).toBeCloseTo(0.5);
    ledger.update({ cell: "ledger", skill: A, outcome: 0, runId: "r2", gate: true });
    expect(ledger.mean("ledger", A)).toBeLessThan(0.5);
    expect(ledger.order({ cell: "ledger", candidates: [A, B, C], mode: "mean" }).order).toEqual([
      "bravo",
      "cedar",
      "alpha",
    ]);
  });

  it("refuses closed gates and duplicate runs", () => {
    const ledger = new SkillPriorLedger();
    expect(ledger.update({ cell: "c", skill: A, outcome: 1, runId: "r", gate: false })).toEqual({
      applied: false,
      reason: "gate-closed",
    });
    expect(ledger.update({ cell: "c", skill: A, outcome: 1, runId: "r", gate: true }).applied).toBe(
      true,
    );
    expect(ledger.update({ cell: "c", skill: A, outcome: 1, runId: "r", gate: true })).toEqual({
      applied: false,
      reason: "duplicate-run",
    });
    expect(ledger.posterior("c", A).n).toBe(1);
  });

  it("initialises a new cell from the skill's global posterior (hierarchical shrinkage)", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 1, pseudoCount: 4 });
    for (let i = 0; i < 8; i++) {
      ledger.update({ cell: "ledger", skill: A, outcome: 1, runId: `r${i}`, gate: true });
    }
    const fresh = ledger.posterior("inventory", A);
    expect(fresh.n).toBe(0);
    expect(fresh.alpha).toBeGreaterThan(fresh.beta);
    expect(ledger.mean("inventory", A)).toBeGreaterThan(0.5);
    expect(ledger.mean("inventory", A)).toBeLessThan(ledger.mean("ledger", A));
  });

  it("resets every cell for a skill when its content hash changes", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 1 });
    for (let i = 0; i < 6; i++) {
      ledger.update({ cell: "ledger", skill: A, outcome: 1, runId: `r${i}`, gate: true });
    }
    expect(ledger.mean("ledger", A)).toBeGreaterThan(0.7);
    const changed = { name: "alpha", hash: "h-a2" };
    expect(ledger.mean("ledger", changed)).toBeCloseTo(0.5);
    expect(ledger.posterior("ledger", changed).n).toBe(0);
    expect(ledger.state.global.alpha?.hash).toBe("h-a2");
  });

  it("discounts old evidence so a verified contradiction flips the order within a few trials", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 0.9 });
    for (let i = 0; i < 20; i++) {
      ledger.update({ cell: "c", skill: A, outcome: 1, runId: `a${i}`, gate: true });
      ledger.update({ cell: "c", skill: B, outcome: 0, runId: `b${i}`, gate: true });
    }
    expect(ledger.order({ cell: "c", candidates: [A, B], mode: "mean" }).order[0]).toBe("alpha");
    let flipped = -1;
    for (let i = 0; i < 30; i++) {
      ledger.update({ cell: "c", skill: A, outcome: 0, runId: `x${i}`, gate: true });
      ledger.update({ cell: "c", skill: B, outcome: 1, runId: `y${i}`, gate: true });
      if (ledger.order({ cell: "c", candidates: [A, B], mode: "mean" }).order[0] === "bravo") {
        flipped = i + 1;
        break;
      }
    }
    expect(flipped).toBeGreaterThan(0);
    expect(flipped).toBeLessThanOrEqual(12);
  });

  it("Thompson ordering is stochastic with propensities that favour the better skill", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 1 });
    for (let i = 0; i < 10; i++) {
      ledger.update({ cell: "c", skill: A, outcome: 1, runId: `a${i}`, gate: true });
      ledger.update({ cell: "c", skill: B, outcome: 0, runId: `b${i}`, gate: true });
    }
    const rng = mulberry32(7);
    const r = ledger.order({ cell: "c", candidates: [A, B, C], mode: "thompson", rng });
    expect(r.propensity).not.toBeNull();
    expect(r.propensity!.alpha).toBeGreaterThan(r.propensity!.bravo);
    const firsts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      firsts.add(
        ledger.order({ cell: "c", candidates: [A, B, C], mode: "thompson", rng }).order[0]!,
      );
    }
    expect(firsts.has("alpha")).toBe(true);
  });

  it("shuffledAcrossCells keeps the weight distribution and breaks the association", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 1 });
    const cells = ["c1", "c2", "c3"];
    cells.forEach((cell, i) => {
      for (let k = 0; k < 10; k++) {
        ledger.update({
          cell,
          skill: A,
          outcome: i === 0 ? 1 : 0,
          runId: `${cell}-${k}`,
          gate: true,
        });
      }
    });
    const shuffled = ledger.shuffledAcrossCells(mulberry32(3));
    const orig = ledger
      .snapshot()
      .map((s) => s.mean.toFixed(4))
      .toSorted();
    const perm = shuffled
      .snapshot()
      .map((s) => s.mean.toFixed(4))
      .toSorted();
    expect(perm).toEqual(orig);
    expect(shuffled.mean("c1", A)).toBeLessThan(ledger.mean("c1", A));
    expect(ledger.mean("c1", A)).toBeGreaterThan(0.8);
  });

  it("round-trips through JSON", () => {
    const ledger = new SkillPriorLedger();
    ledger.update({ cell: "c", skill: A, outcome: 1, runId: "r", gate: true });
    const copy = SkillPriorLedger.fromJSON(ledger.toJSON());
    expect(copy.snapshot()).toEqual(ledger.snapshot());
    expect(() => SkillPriorLedger.fromJSON("{}")).toThrow();
  });
});

describe("prompt surgery", () => {
  it("reads the index order", () => {
    expect(skillOrderInPrompt(PROMPT)).toEqual(["alpha", "bravo", "cedar"]);
  });

  it("permutes blocks and changes nothing else", () => {
    const out = reorderSkillsPrompt(PROMPT, ["cedar", "alpha"]);
    expect(skillOrderInPrompt(out)).toEqual(["cedar", "alpha", "bravo"]);
    expect(out.length).toBe(PROMPT.length);
    expect(out.startsWith("The following skills")).toBe(true);
    expect(out.endsWith("</available_skills>\n")).toBe(true);
    expect(out.split("<skill>").length).toBe(4);
  });

  it("is a no-op for unknown names, identical orders and single-skill prompts", () => {
    expect(reorderSkillsPrompt(PROMPT, ["zulu"])).toBe(PROMPT);
    expect(reorderSkillsPrompt(PROMPT, ["alpha", "bravo", "cedar"])).toBe(PROMPT);
    const single = PROMPT.replace(/ {2}<skill>\n {4}<name>bravo[\s\S]*?<\/skill>\n/, "").replace(
      / {2}<skill>\n {4}<name>cedar[\s\S]*?<\/skill>\n/,
      "",
    );
    expect(reorderSkillsPrompt(single, ["alpha"])).toBe(single);
  });

  it("applySkillPrior is the baseline under an empty ledger and reorders under a learned one", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 1 });
    const hashes = { alpha: "h-a", bravo: "h-b", cedar: "h-c" };
    const idle = applySkillPrior({ prompt: PROMPT, cell: "c", ledger, hashes, mode: "mean" });
    expect(idle.changed).toBe(false);
    for (let i = 0; i < 5; i++) {
      ledger.update({ cell: "c", skill: C, outcome: 1, runId: `r${i}`, gate: true });
    }
    const learned = applySkillPrior({ prompt: PROMPT, cell: "c", ledger, hashes, mode: "mean" });
    expect(learned.changed).toBe(true);
    expect(learned.order[0]).toBe("cedar");
    expect(learned.baseline).toEqual(["alpha", "bravo", "cedar"]);
    const off = applySkillPrior({ prompt: PROMPT, cell: "c", ledger, hashes, mode: "off" });
    expect(off.prompt).toBe(PROMPT);
    const last = applySkillPrior({
      prompt: PROMPT,
      cell: "c",
      ledger,
      hashes,
      mode: "mean",
      placement: "last",
    });
    expect(last.order.at(-1)).toBe("cedar");
    expect(last.result?.order[0]).toBe("cedar");
  });
});

describe("evidence annotation", () => {
  it("adds an evidence line inside the named skill blocks only, keeping order", () => {
    const out = annotateSkillsPrompt(PROMPT, {
      bravo: { passed: 5, runs: 5 },
      cedar: { passed: 0, runs: 0 },
    });
    expect(skillOrderInPrompt(out)).toEqual(["alpha", "bravo", "cedar"]);
    expect(out).toContain(
      "    <location>/s/bravo/SKILL.md</location>\n    <evidence>Verified record in past tasks like this one: 5 of 5 runs passed.</evidence>\n  </skill>",
    );
    expect(out.match(/<evidence>/g)).toHaveLength(1);
    expect(out.replace(/ {4}<evidence>.*<\/evidence>\n/, "")).toBe(PROMPT);
  });

  it("words a verdict without numbers in verdict style", () => {
    const out = annotateSkillsPrompt(
      PROMPT,
      { alpha: { passed: 1, runs: 4 }, cedar: { passed: 2, runs: 4 } },
      "verdict",
    );
    expect(out).toContain("<evidence>This skill failed in past tasks like this one.</evidence>");
    expect(out).toContain("<evidence>This skill worked in past tasks like this one.</evidence>");
    expect(out).not.toMatch(/<evidence>[^<]*\d/);
  });

  it("shows only a usage count, never an outcome, in usage (placebo) style", () => {
    const out = annotateSkillsPrompt(
      PROMPT,
      { alpha: { passed: 0, runs: 2 }, cedar: { passed: 2, runs: 2 } },
      "usage",
    );
    expect(
      out.match(/<evidence>Usage record in past tasks like this one: 2 runs logged\.<\/evidence>/g),
    ).toHaveLength(2);
    expect(out).not.toMatch(/passed|worked|failed/);
  });

  it("returns the prompt unchanged with no evidence", () => {
    expect(annotateSkillsPrompt(PROMPT, {})).toBe(PROMPT);
  });
});

describe("samplers", () => {
  it("Beta draws stay in [0,1] with the right mean", () => {
    const rng = mulberry32(11);
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const x = sampleBeta(8, 2, rng);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      sum += x;
    }
    expect(sum / n).toBeCloseTo(0.8, 1);
  });

  it("derange never leaves a fixed point for n >= 2", () => {
    const rng = mulberry32(5);
    for (let t = 0; t < 50; t++) {
      const items = ["a", "b", "c", "d"];
      const out = derange(items, rng);
      items.forEach((x, i) => expect(out[i]).not.toBe(x));
    }
  });
});

describe("verified evidence counters", () => {
  it("counts only explicitly verified, eligible, unique observations without discounting", () => {
    const ledger = new SkillPriorLedger(undefined, { discount: 0.5, pseudoCount: 20 });
    const base = { cell: "c", skill: A, outcome: 1 as const, gate: true };
    ledger.update({ ...base, runId: "read-only" });
    ledger.update({ ...base, runId: "unverified", verified: false });
    ledger.update({ ...base, runId: "closed", gate: false, verified: true });
    expect(ledger.verifiedEvidence("c", A)).toBeNull();
    ledger.update({ ...base, runId: "pass", verified: true });
    ledger.update({ ...base, runId: "fail", outcome: 0, verified: true });
    ledger.update({ ...base, runId: "pass", verified: true });
    expect(ledger.posterior("c", A).n).toBe(4);
    expect(ledger.verifiedEvidence("c", A)).toEqual({ passed: 1, runs: 2 });
    expect(SkillPriorLedger.fromJSON(ledger.toJSON()).verifiedEvidence("c", A)).toEqual({
      passed: 1,
      runs: 2,
    });
    // Pooled posterior information must not become local outcome evidence.
    ledger.posterior("other", A);
    expect(ledger.verifiedEvidence("other", A)).toBeNull();
    expect(ledger.verifiedEvidence("c", B)).toBeNull();
  });

  it("loads a legacy ledger without inventing counts, then counts only fresh verified runs", () => {
    const ledger = SkillPriorLedger.fromJSON(
      JSON.stringify({
        version: 1,
        cells: { c: { alpha: { hash: A.hash, alpha: 10, beta: 2, n: 7 } } },
        global: {},
        seen: ["old|alpha"],
      }),
    );
    expect(ledger.order({ cell: "c", candidates: [B, A], mode: "mean" }).order[0]).toBe(A.name);
    expect(ledger.verifiedEvidence("c", A)).toBeNull();
    ledger.update({ cell: "c", skill: A, outcome: 0, runId: "new", gate: true, verified: true });
    expect(ledger.posterior("c", A).n).toBe(8);
    expect(ledger.verifiedEvidence("c", A)).toEqual({ passed: 0, runs: 1 });
  });

  it("excludes old or unknown skill hashes and resets counts on a version change", () => {
    const ledger = new SkillPriorLedger();
    ledger.update({ cell: "c", skill: A, outcome: 1, runId: "r1", gate: true, verified: true });
    const changed = { ...A, hash: "new-hash" };
    expect(ledger.verifiedEvidence("c", changed)).toBeNull();
    ledger.update({
      cell: "c",
      skill: changed,
      outcome: 0,
      runId: "r2",
      gate: true,
      verified: true,
    });
    expect(ledger.verifiedEvidence("c", changed)).toEqual({ passed: 0, runs: 1 });
    expect(ledger.verifiedEvidence("c", A)).toBeNull();
    const unknown = { ...A, hash: "unknown" };
    ledger.update({
      cell: "c",
      skill: unknown,
      outcome: 1,
      runId: "r3",
      gate: true,
      verified: true,
    });
    expect(ledger.verifiedEvidence("c", unknown)).toBeNull();
  });

  it.each([
    { passed: 2, runs: 1 },
    { passed: -1, runs: 2 },
    { passed: 1, runs: 1.5 },
    { passed: 0, runs: 0 },
    { passed: 0, runs: 6 },
    { passed: 0, runs: Number.MAX_SAFE_INTEGER + 1 },
  ])("excludes malformed or impossible persisted counters: %j", (verifiedEvidence) => {
    const ledger = SkillPriorLedger.fromJSON(
      JSON.stringify({
        version: 1,
        cells: { c: { alpha: { hash: A.hash, alpha: 3, beta: 3, n: 5, verifiedEvidence } } },
      }),
    );
    expect(ledger.verifiedEvidence("c", A)).toBeNull();
  });

  it("does not label deliberately shuffled cells as verified local evidence", () => {
    const ledger = new SkillPriorLedger();
    for (const [i, cell] of ["c1", "c2"].entries()) {
      ledger.update({
        cell,
        skill: A,
        outcome: i === 0 ? 1 : 0,
        runId: cell,
        gate: true,
        verified: true,
      });
    }
    const shuffled = ledger.shuffledAcrossCells(mulberry32(3));
    expect(shuffled.verifiedEvidence("c1", A)).toBeNull();
    expect(shuffled.verifiedEvidence("c2", A)).toBeNull();
    expect(ledger.verifiedEvidence("c1", A)).toEqual({ passed: 1, runs: 1 });
  });
});

describe("verbal evidence wording", () => {
  it.each([
    [0, 1, "REJECTED every time it was used (1 use)"],
    [0, 3, "REJECTED every time it was used (3 uses)"],
    [1, 1, "ACCEPTED every time it was used (1 use)"],
    [3, 3, "ACCEPTED every time it was used (3 uses)"],
    [2, 3, "accepted 2 of 3 uses, rejected the rest"],
  ])("preserves the benchmark wording for %i/%i", (passed, runs, expected) => {
    const evidence = { passed, runs };
    expect(verbalRecord(evidence)).toBe(expected);
    expect(formatSkillEvidence(evidence, "verbal")).toBe(expected);
    const prompt = annotateSkillsPrompt(PROMPT, { alpha: evidence }, "verbal");
    expect(prompt).toContain(`<evidence>${expected}</evidence>`);
    expect(prompt.replace(/ {4}<evidence>.*<\/evidence>\n/, "")).toBe(PROMPT);
  });

  it("leaves zero-run and invalid skill entries byte-identical", () => {
    expect(verbalRecord({ passed: 0, runs: 0 })).toBe("not tried yet");
    expect(
      annotateSkillsPrompt(
        PROMPT,
        {
          alpha: { passed: 0, runs: 0 },
          bravo: { passed: 5, runs: 2 },
          cedar: { passed: 0, runs: -1 },
        },
        "verbal",
      ),
    ).toBe(PROMPT);
  });
});
