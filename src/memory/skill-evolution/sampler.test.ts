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
  PENDING_TTL_MS,
  readSamplerCursor,
  readSamplerState,
  sampleIteration,
  writeSamplerCursor,
  writeSamplerState,
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

  it("excludes evolution/probe/remote-a2a sessions and tool-less runs", async () => {
    const journal = makeFixtureJournal();
    const [probeId, evolveId, toolless, a2aId, genuine] = [...findRunIds(5, false, "ex")] as [
      string,
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
    // PLAN-43 R2: a remote caller's task run is prime tool-bearing fodder
    // and must never reach the wiki/proposer.
    appendFixtureRun(journal, {
      runId: a2aId,
      sessionKey: "agent:main:a2a-task:0f9e8d7c",
      steps: failSteps(),
      terminal: "error",
    });
    appendFixtureRun(journal, {
      runId: genuine,
      sessionKey: "agent:main:main",
      steps: failSteps(),
      terminal: "error",
    });
    const result = await sampleIteration(journal, { cursorSeq: 0 });
    expect(result.samples.map((s) => s.trace.runId)).toEqual([genuine]);
    expect(result.stats.runsExcluded).toBe(4);
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

// PLAN-44 Phase 0 — I2: cursor safety on interleaved / in-flight runs, and
// D-6 origin/heartbeat exclusion from the journaled task header.
describe("cursor safety (PLAN-44 I2)", () => {
  it("never advances the cursor past the first event of a run it did not examine", async () => {
    const journal = makeFixtureJournal();
    const [longId, ...shortIds] = findRunIds(4, false, "il") as [string, string, string, string];
    // A long run starts FIRST, then three short runs complete inside it,
    // then the long run ends. With maxRunsExamined=2 the scan keeps the two
    // earliest-ending runs; the third short run and the long run are cut.
    let seq = 0;
    const emit = (runId: string, stream: string, data: Record<string, unknown>) => {
      seq += 1;
      journal.append({ runId, seq, stream, ts: Date.now() + seq, data });
    };
    emit(longId, "lifecycle", { phase: "start" });
    for (const id of shortIds) {
      emit(id, "lifecycle", { phase: "start" });
      emit(id, "tool", { phase: "start", name: "exec", toolCallId: `c-${id}`, args: {} });
      emit(id, "tool", {
        phase: "result",
        name: "exec",
        toolCallId: `c-${id}`,
        isError: true,
        result: "boom",
      });
      emit(id, "lifecycle", { phase: "error", error: "x" });
    }
    emit(longId, "tool", { phase: "start", name: "exec", toolCallId: "c-long", args: {} });
    emit(longId, "tool", {
      phase: "result",
      name: "exec",
      toolCallId: "c-long",
      isError: false,
      result: "ok",
    });
    emit(longId, "lifecycle", { phase: "end" });

    const first = await sampleIteration(journal, { cursorSeq: 0, maxRunsExamined: 2 });
    expect(first.samples.map((s) => s.trace.runId)).toEqual([shortIds[0], shortIds[1]]);
    // The cursor stops before the third short run's first event — and well
    // before the long run's true last event.
    const thirdFirstSeq = 1 + 2 * 4 + 1;
    expect(first.nextCursorSeq).toBeLessThan(thirdFirstSeq);
    expect(first.nextCursorSeq).toBeGreaterThan(0);

    const second = await sampleIteration(journal, {
      cursorSeq: first.nextCursorSeq,
      maxRunsExamined: 2,
      processedRunIds: first.processedRunIds,
    });
    const ids = second.samples.map((s) => s.trace.runId);
    expect(ids).toContain(shortIds[2]);
    // Straddling runs already examined are not re-sampled.
    expect(ids).not.toContain(shortIds[0]);
    expect(ids).not.toContain(shortIds[1]);
  });

  it("defers in-flight runs to the pending list and re-examines them once complete", async () => {
    const journal = makeFixtureJournal();
    const [inflight, done] = findRunIds(2, false, "pend") as [string, string];
    appendFixtureRun(journal, { runId: inflight, steps: failSteps(), terminal: "none" });
    appendFixtureRun(journal, { runId: done, steps: passSteps() });
    const first = await sampleIteration(journal, { cursorSeq: 0 });
    expect(first.samples.map((s) => s.trace.runId)).toEqual([done]);
    expect(first.pending.map((p) => p.runId)).toEqual([inflight]);
    expect(first.stats.runsIncomplete).toBe(1);
    // The run finishes later (its terminal event lands beyond the cursor).
    journal.append({
      runId: inflight,
      seq: 99,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "late failure" },
    });
    const second = await sampleIteration(journal, {
      cursorSeq: first.nextCursorSeq,
      pending: first.pending,
      processedRunIds: first.processedRunIds,
    });
    expect(second.stats.pendingReexamined).toBe(1);
    expect(second.samples.map((s) => s.trace.runId)).toEqual([inflight]);
    expect(second.pending).toEqual([]);
  });

  it("expires pending entries older than the TTL", async () => {
    const journal = makeFixtureJournal();
    const [inflight] = findRunIds(1, false, "ttl") as [string];
    appendFixtureRun(journal, { runId: inflight, steps: failSteps(), terminal: "none" });
    const now = Date.now();
    const result = await sampleIteration(journal, {
      cursorSeq: 0,
      pending: [{ runId: inflight, firstSeenAt: now - PENDING_TTL_MS - 1 }],
      now,
    });
    expect(result.stats.pendingReexamined).toBe(0);
  });

  it("excludes heartbeat runs and third-party-origin runs via the task header (D-6)", async () => {
    const journal = makeFixtureJournal();
    const [hb, circle, human] = findRunIds(3, false, "org") as [string, string, string];
    appendFixtureRun(journal, {
      runId: hb,
      sessionKey: "agent:main:main",
      task: { text: "heartbeat", isHeartbeat: true },
      steps: failSteps(),
      terminal: "error",
    });
    appendFixtureRun(journal, {
      runId: circle,
      sessionKey: "agent:main:circle:c1",
      task: { text: "post this to the circle" },
      steps: failSteps(),
      terminal: "error",
    });
    appendFixtureRun(journal, {
      runId: human,
      sessionKey: "agent:main:main",
      task: { text: "fix the build" },
      steps: failSteps(),
      terminal: "error",
    });
    const result = await sampleIteration(journal, { cursorSeq: 0 });
    expect(result.samples.map((s) => s.trace.runId)).toEqual([human]);
    expect(result.stats.runsHeartbeat).toBe(1);
    expect(result.stats.runsUntrustedOrigin).toBe(1);
    expect(result.stats.runsWithTask).toBe(3);
    expect(result.samples[0]?.formattedLog).toContain("task: fix the build");
  });
});

describe("sampler state (PLAN-44)", () => {
  it("writeSamplerCursor preserves pending and processed; writes are atomic", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sampler-state2-"));
    try {
      await writeSamplerState(
        { cursorSeq: 10, pending: [{ runId: "r1", firstSeenAt: 5 }], processed: ["p1"] },
        { configDir: tmpDir },
      );
      await writeSamplerCursor(20, { configDir: tmpDir });
      const state = await readSamplerState({ configDir: tmpDir });
      expect(state.cursorSeq).toBe(20);
      expect(state.pending).toEqual([{ runId: "r1", firstSeenAt: 5 }]);
      expect(state.processed).toEqual(["p1"]);
      const files = await fs.readdir(path.join(tmpDir, "skill-wiki"));
      expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
