import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  GATE,
  GATE2,
  GATE_REP,
  importCardBundle,
  runGate,
  type CardBundle,
  type EvalRow,
  type GateStep,
} from "./cross-agent.js";

/**
 * The published cross-agent evidence must reproduce its own headline
 * numbers: every gate step recomputed from the raw records has to match
 * the summary written when the study ran.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const published = path.join(here, "published");

interface Rec {
  phase: string;
  arm: string;
  cell?: string;
  family: string;
  taskId: string;
  pass: number;
  error: string | null;
}

function rowsOf(dir: string, phases: readonly string[]): EvalRow[] {
  const raw = gunzipSync(fs.readFileSync(path.join(published, dir, "records.jsonl.gz")));
  return raw
    .toString("utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec)
    .filter((r) => phases.includes(r.phase))
    .map((r) => ({
      arm: r.arm,
      cell: r.cell!,
      family: r.family,
      taskId: r.taskId,
      pass: r.error === null ? r.pass : 0,
    }));
}

interface SummaryStep {
  id: string;
  n: number;
  mean: number;
  wins: number;
  losses: number;
  ties: number;
  passed: boolean;
  confirmatory: boolean;
}

function summaryGate(dir: string, file: string): SummaryStep[] {
  return (
    JSON.parse(fs.readFileSync(path.join(published, dir, file), "utf-8")) as {
      gate: SummaryStep[];
    }
  ).gate;
}

const CASES: ReadonlyArray<{
  name: string;
  dir: string;
  phases: readonly string[];
  summary: string;
  gate: readonly GateStep[];
}> = [
  {
    name: "first study",
    dir: "cross-agent-20261115",
    phases: ["xa-eval"],
    summary: "summary-xa-eval.json",
    gate: GATE,
  },
  {
    name: "follow-up",
    dir: "cross-agent-20261115",
    phases: ["xa-eval", "xa-eval2"],
    summary: "summary-xa-eval2.json",
    gate: GATE2,
  },
  {
    name: "replication",
    dir: "cross-agent-rep-20261116",
    phases: ["xa-rep"],
    summary: "summary-xa-rep.json",
    gate: GATE_REP,
  },
];

describe("published cross-agent evidence", () => {
  for (const c of CASES) {
    it(`${c.name}: the gate recomputed from the records matches the summary`, () => {
      const got = runGate(rowsOf(c.dir, c.phases), c.gate);
      const want = summaryGate(c.dir, c.summary);
      expect(got.map((g) => g.id)).toEqual(want.map((w) => w.id));
      got.forEach((g, i) => {
        const w = want[i]!;
        expect(g.n).toBe(w.n);
        expect(g.mean).toBeCloseTo(w.mean, 10);
        expect([g.wins, g.losses, g.ties]).toEqual([w.wins, w.losses, w.ties]);
        expect(g.passed).toBe(w.passed);
        expect(g.confirmatory).toBe(w.confirmatory);
      });
    });
  }

  it("replication: all three registered steps are confirmed", () => {
    const got = runGate(rowsOf("cross-agent-rep-20261116", ["xa-rep"]), GATE_REP);
    expect(got.map((g) => g.passed && g.confirmatory)).toEqual([true, true, true]);
  });

  it("every published bundle carries a valid signature from its stated origin", () => {
    for (const dir of ["cross-agent-20261115", "cross-agent-rep-20261116"]) {
      const bdir = path.join(published, dir, "bundles");
      for (const f of fs.readdirSync(bdir)) {
        const b = JSON.parse(fs.readFileSync(path.join(bdir, f), "utf-8")) as CardBundle;
        const res = importCardBundle(b, {
          trustedOrigins: new Set([b.origin]),
          localSkills: b.skills,
        });
        expect(res.ok, `${dir}/${f}`).toBe(true);
      }
    }
  });
});
