import { describe, expect, it } from "vitest";
import {
  applySkillPrior,
  derange,
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
