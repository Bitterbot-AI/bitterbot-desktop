import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import {
  isRunHeldOut,
  MAX_FAILING_TRACES,
  MAX_PASSING_TRACES,
  MAX_TRACES_PER_ITERATION,
  readSamplerCursor,
  sampleIteration,
  writeSamplerCursor,
} from "./sampler.js";

/** Deterministically find run ids inside/outside the held-out partition. */
function findRunIds(count: number, heldOut: boolean, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count && i < 10_000; i++) {
    const id = `${prefix}-${i}`;
    if (isRunHeldOut(id) === heldOut) {
      out.push(id);
    }
  }
  return out;
}

function failSteps() {
  return [{ kind: "tool" as const, name: "exec", result: "boom", isError: true }];
}

function passSteps() {
  return [{ kind: "tool" as const, name: "read", result: "ok" }];
}

describe("sampleIteration", () => {
  it("enforces the paper's stratified budget: <=5 fail + <=3 pass, <=8 total", async () => {
    const journal = makeFixtureJournal();
    for (const id of findRunIds(10, false, "fail")) {
      appendFixtureRun(journal, { runId: id, steps: failSteps(), terminal: "error" });
    }
    for (const id of findRunIds(6, false, "pass")) {
      appendFixtureRun(journal, {
        runId: id,
        steps: passSteps(),
        completedExplicitly: true,
      });
    }
    const result = await sampleIteration(journal, { cursorSeq: 0 });
    expect(result.samples.length).toBeLessThanOrEqual(MAX_TRACES_PER_ITERATION);
    expect(result.stats.failsSelected).toBe(MAX_FAILING_TRACES);
    expect(result.stats.passesSelected).toBe(MAX_PASSING_TRACES);
    for (const s of result.samples) {
      expect(s.formattedLog.length).toBeLessThanOrEqual(15_000);
    }
  });

  it("never samples held-out runs (reserved for the validation gate)", async () => {
    const journal = makeFixtureJournal();
    for (const id of findRunIds(4, true, "ho")) {
      appendFixtureRun(journal, { runId: id, steps: failSteps(), terminal: "error" });
    }
    const result = await sampleIteration(journal, { cursorSeq: 0 });
    expect(result.samples).toHaveLength(0);
    expect(result.stats.runsHeldOut).toBe(4);
  });

  it("excludes evolution/probe sessions and tool-less runs", async () => {
    const journal = makeFixtureJournal();
    const [probeId, evolveId, toolless, genuine] = [...findRunIds(4, false, "ex")] as [
      string,
      string,
      string,
      string,
    ];
    appendFixtureRun(journal, {
      runId: probeId,
      sessionKey: "agent:main:probe-x1",
      steps: failSteps(),
      terminal: "error",
    });
    appendFixtureRun(journal, {
      runId: evolveId,
      sessionKey: "skill-evolve:validation",
      steps: failSteps(),
      terminal: "error",
    });
    appendFixtureRun(journal, {
      runId: toolless,
      steps: [{ kind: "assistant", texts: ["just chatting"] }],
    });
    appendFixtureRun(journal, {
      runId: genuine,
      sessionKey: "agent:main:main",
      steps: failSteps(),
      terminal: "error",
    });
    const result = await sampleIteration(journal, { cursorSeq: 0 });
    expect(result.samples.map((s) => s.trace.runId)).toEqual([genuine]);
    expect(result.stats.runsExcluded).toBe(3);
  });

  it("advances the cursor monotonically so runs are never rescanned", async () => {
    const journal = makeFixtureJournal();
    for (const id of findRunIds(3, false, "cur")) {
      appendFixtureRun(journal, { runId: id, steps: passSteps() });
    }
    const first = await sampleIteration(journal, { cursorSeq: 0 });
    expect(first.samples.length).toBeGreaterThan(0);
    expect(first.nextCursorSeq).toBeGreaterThan(0);
    const second = await sampleIteration(journal, { cursorSeq: first.nextCursorSeq });
    expect(second.samples).toHaveLength(0);
    expect(second.stats.runsExamined).toBe(0);
  });

  it("counts judge calls and only judges ambiguous traces", async () => {
    const journal = makeFixtureJournal();
    const [ambiguous, confident] = findRunIds(2, false, "jj") as [string, string];
    // Clean end without complete(): weak pass -> judge consulted.
    appendFixtureRun(journal, { runId: ambiguous, steps: passSteps() });
    // Lifecycle error: confident fail -> judge skipped.
    appendFixtureRun(journal, { runId: confident, steps: failSteps(), terminal: "error" });
    let calls = 0;
    const result = await sampleIteration(journal, {
      cursorSeq: 0,
      judgeCall: async () => {
        calls += 1;
        return "verdict: pass";
      },
    });
    expect(calls).toBe(1);
    expect(result.stats.judgeCalls).toBe(1);
    expect(result.samples).toHaveLength(2);
  });
});

describe("sampler cursor persistence", () => {
  it("round-trips through skill-wiki/.sampler-state.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sampler-state-"));
    try {
      expect(await readSamplerCursor({ configDir: tmpDir })).toBe(0);
      await writeSamplerCursor(1234, { configDir: tmpDir });
      expect(await readSamplerCursor({ configDir: tmpDir })).toBe(1234);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
