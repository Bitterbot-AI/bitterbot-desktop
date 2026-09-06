/**
 * PLAN-45 Phase 1.5: the blind calibration set and its scoring.
 */

import { describe, expect, it } from "vitest";
import type { TraceLabel } from "./types.js";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import {
  buildCalibrationSet,
  type CalibrationKeyRow,
  cohensKappa,
  parseLabelFile,
  scoreCalibration,
} from "./calibration.js";

function key(
  id: string,
  heuristic: TraceLabel,
  judged: TraceLabel | null = null,
): CalibrationKeyRow {
  return {
    id,
    heuristic: { label: heuristic, confidence: 0.6, reason: "t" },
    judged: judged ? { label: judged, confidence: 0.8, reason: "j" } : null,
    origin: "human",
    model: null,
    toolCalls: 1,
    evidenceLevel: 1,
  };
}

describe("buildCalibrationSet", () => {
  it("exports blind logs without labels, stratifies across the labeler's classes, and hides the key", async () => {
    const journal = makeFixtureJournal();
    for (let i = 0; i < 6; i++) {
      appendFixtureRun(journal, {
        runId: `pass-${i}`,
        task: { text: `List the files in project ${i}` },
        steps: [{ kind: "tool", name: "exec", result: "a.txt" }],
        completedExplicitly: true,
      });
    }
    for (let i = 0; i < 2; i++) {
      appendFixtureRun(journal, {
        runId: `fail-${i}`,
        task: { text: `Read config ${i}` },
        // Terminal agent-side tool failure with a clean lifecycle end = fail
        // (a lifecycle error would be an env-fail: the provider died).
        steps: [{ kind: "tool", name: "read", isError: true, result: "ENOENT: no such file" }],
      });
    }
    // Excluded shapes: heartbeat, no tools, no terminal.
    appendFixtureRun(journal, {
      runId: "hb",
      task: { text: "heartbeat", isHeartbeat: true },
      steps: [{ kind: "tool", name: "exec" }],
    });
    appendFixtureRun(journal, { runId: "notools", task: { text: "hi" }, steps: [] });
    appendFixtureRun(journal, {
      runId: "inflight",
      task: { text: "x" },
      steps: [{ kind: "tool", name: "exec" }],
      terminal: "none",
    });

    const set = await buildCalibrationSet({ journal, count: 4, seed: "s1", now: 1 });
    expect(set.blind).toHaveLength(4);
    expect(set.key).toHaveLength(4);
    // Round-robin over classes: both failing runs are in a 4-row sample.
    const labels = set.key.map((k) => k.heuristic.label);
    expect(labels.filter((l) => l === "fail")).toHaveLength(2);
    expect(labels.filter((l) => l === "pass")).toHaveLength(2);
    for (const row of set.blind) {
      expect(row).toEqual({ id: expect.any(String), log: expect.any(String) });
      expect(row.log).toContain("task:");
      // Blind: no answer key in the header (adversarial H1).
      expect(row.log).not.toMatch(
        /^outcome:|^tools:|evidence-level|## Signals|error-classes|complete\(\)/m,
      );
      // ...but the raw tool output the human needs is still there.
      expect(row.log).toMatch(/\[tool (exec|read)/);
    }
    // 6 pass + 2 fail + the heartbeat are terminal tool-bearing runs; the
    // tool-less and in-flight runs never reach eligibility.
    expect(set.stats.runsScanned).toBe(9);
    expect(set.stats.runsEligible).toBe(8);
    expect(set.stats.runsExcluded).toBe(1);
    // Deterministic under the same seed.
    const again = await buildCalibrationSet({ journal, count: 4, seed: "s1", now: 1 });
    expect(again.key.map((k) => k.id)).toEqual(set.key.map((k) => k.id));
  });

  it("records the judge's label per trace when a judge is supplied", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "amb",
      task: { text: "Fetch the weather" },
      steps: [
        { kind: "tool", name: "read", result: "ok" },
        { kind: "tool", name: "read", result: "ok" },
      ],
    });
    const set = await buildCalibrationSet({
      journal,
      count: 1,
      judgeCall: async () => "verdict: fail",
    });
    expect(set.key[0]?.judged?.label).toBe("fail");
    expect(set.stats.judgeCalls).toBe(1);
  });
});

describe("scoreCalibration", () => {
  it("computes per-class precision/recall against one rater", () => {
    const k = [key("a", "pass"), key("b", "pass"), key("c", "fail"), key("d", "env-fail")];
    const rater = parseLabelFile(
      [
        '{"id":"a","label":"pass"}',
        '{"id":"b","label":"fail","note":"wrong answer"}',
        '{"id":"c","label":"fail"}',
        '{"id":"d","label":"env-fail"}',
      ].join("\n"),
    );
    const r = scoreCalibration(k, rater);
    expect(r.heuristicVsA.n).toBe(4);
    expect(r.heuristicVsA.accuracy).toBe(0.75);
    const pass = r.heuristicVsA.perClass.find((c) => c.label === "pass")!;
    expect(pass).toMatchObject({ tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1 });
    const fail = r.heuristicVsA.perClass.find((c) => c.label === "fail")!;
    expect(fail).toMatchObject({ tp: 1, fp: 0, fn: 1, precision: 1, recall: 0.5 });
    expect(r.judgedVsA).toBeNull();
    expect(r.interRater).toBeNull();
  });

  it("scores two raters: kappa and consensus-only metrics", () => {
    const k = [
      key("a", "pass", "pass"),
      key("b", "fail", "pass"),
      key("c", "fail", "fail"),
      key("d", "pass", "fail"),
    ];
    const a = parseLabelFile(
      '{"id":"a","label":"pass"}\n{"id":"b","label":"fail"}\n{"id":"c","label":"fail"}\n{"id":"d","label":"pass"}',
    );
    const b = parseLabelFile(
      '{"id":"a","label":"pass"}\n{"id":"b","label":"fail"}\n{"id":"c","label":"pass"}\n{"id":"d","label":"pass"}',
    );
    const r = scoreCalibration(k, a, b);
    expect(r.interRater?.n).toBe(4);
    expect(r.interRater?.agreement).toBe(0.75);
    // Consensus = a, b, d (c disagrees).
    expect(r.heuristicVsConsensus?.n).toBe(3);
    expect(r.heuristicVsConsensus?.accuracy).toBe(1);
    // Judge on consensus rows a/b/d: pass/pass/fail vs truth pass/fail/pass.
    expect(r.judgedVsConsensus?.accuracy).toBeCloseTo(1 / 3);
  });

  it("cohensKappa handles perfect agreement and chance", () => {
    const a = new Map<string, TraceLabel>([
      ["1", "pass"],
      ["2", "fail"],
    ]);
    expect(cohensKappa(a, a).kappa).toBe(1);
    const b = new Map<string, TraceLabel>([
      ["1", "fail"],
      ["2", "pass"],
    ]);
    expect(cohensKappa(a, b).kappa).toBeLessThan(0);
    expect(cohensKappa(a, new Map()).kappa).toBeNull();
  });

  it("rejects malformed label rows", () => {
    expect(() => parseLabelFile('{"id":"a","label":"meh"}')).toThrow(/invalid label row/);
  });
});
