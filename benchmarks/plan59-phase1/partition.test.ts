import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "./common.js";
import { assertFinalAllowed, partitionQuestions, questionsIn, SPLITS } from "./partition.js";
import { question } from "./test-support.js";

const questions = Array.from({ length: 120 }, (_, i) =>
  question(`c${i}`, `sessions/s${i % 40}.jsonl`, i, i + 2),
);
const params = { seed: "59", questionsSha256: "abc", createdAt: "2026-10-29T00:00:00.000Z" };

describe("partitionQuestions", () => {
  it("is deterministic for a seed and cuts families 50 / 25 / 25", () => {
    const a = partitionQuestions(questions, params);
    const b = partitionQuestions(questions, params);
    expect(a).toEqual(b);
    expect(a.counts.development.families).toBe(20);
    expect(a.counts.qualification.families).toBe(10);
    expect(a.counts.final.families).toBe(10);
    expect(
      a.counts.development.questions + a.counts.qualification.questions + a.counts.final.questions,
    ).toBe(120);
  });

  it("keeps every question of a family in one split (disjoint by family)", () => {
    const p = partitionQuestions(questions, params);
    const splitByFamilyHash = new Map<string, string>();
    for (const a of p.assignments) {
      const prev = splitByFamilyHash.get(a.familyHash);
      if (prev) expect(prev).toBe(a.split);
      splitByFamilyHash.set(a.familyHash, a.split);
    }
    const ids = new Set(p.assignments.map((a) => a.chunkId));
    expect(ids.size).toBe(120);
  });

  it("changes the cut with the seed and never stores a path or question", () => {
    const a = partitionQuestions(questions, params);
    const b = partitionQuestions(questions, { ...params, seed: "60" });
    expect(a.assignments.map((x) => x.split)).not.toEqual(b.assignments.map((x) => x.split));
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain("sessions/");
    expect(serialized).not.toContain("q about");
  });
});

describe("questionsIn", () => {
  const p = partitionQuestions(questions, params);

  it("returns the split's questions and refuses a mismatched question file", () => {
    const dev = questionsIn("development", questions, p, { questionsSha256: "abc" });
    const qual = questionsIn("qualification", questions, p);
    expect(dev.length).toBe(p.counts.development.questions);
    expect(qual.length).toBe(p.counts.qualification.questions);
    expect(dev.some((q) => qual.includes(q))).toBe(false);
    expect(() => questionsIn("development", questions, p, { questionsSha256: "zzz" })).toThrow(
      /different question file/,
    );
  });

  it("refuses the final partition without an opened gate", () => {
    expect(() => questionsIn("final", questions, p)).toThrow(/sealed/);
    expect(SPLITS).toContain("final");
  });

  it("opens the final partition only with --final and the frozen protocol hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan59-proto-"));
    const protocolPath = join(dir, "protocol.frozen.md");
    const body = "# protocol\nstatus: frozen\nprimary: MRR\n";
    writeFileSync(protocolPath, body);
    expect(() => assertFinalAllowed({ final: false, freeze: sha256(body), protocolPath })).toThrow(
      /--final/,
    );
    expect(() => assertFinalAllowed({ final: true, protocolPath })).toThrow(/--freeze/);
    expect(() => assertFinalAllowed({ final: true, freeze: "deadbeef", protocolPath })).toThrow(
      /does not match/,
    );
    const draft = join(dir, "draft.md");
    writeFileSync(draft, "status: draft\n");
    expect(() =>
      assertFinalAllowed({ final: true, freeze: sha256("status: draft\n"), protocolPath: draft }),
    ).toThrow(/not marked/);
    const gate = assertFinalAllowed({ final: true, freeze: sha256(body), protocolPath });
    expect(gate.opened).toBe(true);
    const fin = questionsIn("final", questions, p, { finalGate: gate });
    expect(fin.length).toBe(p.counts.final.questions);
  });
});
