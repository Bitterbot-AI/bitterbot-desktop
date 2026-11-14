import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { validateCorpus } from "./deployment-contract.js";
import { missingFinalCoverage } from "./deployment-report.js";
import { assertRetentionReady } from "./node-contract.js";
import { createPilotCorpus } from "./pilot-corpus.js";
import { StudyLedger } from "./study-ledger.js";
import type { PairedObservation } from "./study.js";

describe("deployment boundaries", () => {
  it("checks the real retention deadline before beginning an execution command", () => {
    const state = { learningEndedAt: "1000", finalRanAt: "2000" };
    expect(() => assertRetentionReady({ ...state, finalRanAt: null }, 24, 86401000)).toThrow(
      "precede retention",
    );
    expect(() => assertRetentionReady(state, 24, 86400999)).toThrow("not due");
    expect(() => assertRetentionReady(state, 24, 86401000)).not.toThrow();
  });
  it("freezes distinct nodes, users, corpus partitions and fresh selection panels", () => {
    const corpus = createPilotCorpus();
    expect(corpus).toEqual(createPilotCorpus());
    for (const node of ["a", "b"]) {
      for (let panel = 0; panel < 20; panel++)
        expect(
          corpus.tasks.filter(
            (t) =>
              t.node === node &&
              t.partition === "selection" &&
              t.selectionPanel === panel &&
              !t.regression,
          ),
        ).toHaveLength(20);
      expect(
        new Set(corpus.tasks.filter((t) => t.node === node && t.newUser).map((t) => t.family)).size,
      ).toBe(20);
    }
    const contaminated = structuredClone(corpus);
    contaminated.tasks.find((t) => t.partition === "final")!.corpus = corpus.tasks[0].corpus;
    expect(() => validateCorpus(contaminated)).toThrow("disjoint");
    const duplicate = structuredClone(corpus);
    duplicate.tasks[1].input = duplicate.tasks[0].input;
    expect(() => validateCorpus(duplicate)).toThrow("Duplicate task content");
    const reusedUser = structuredClone(corpus);
    reusedUser.tasks.find((t) => t.newUser)!.user = "known-a";
    expect(() => validateCorpus(reusedUser)).toThrow("already appeared");
    expect(() => validateCorpus({ ...corpus, provenance: "frozen-independent-corpus" })).toThrow(
      "unseen final environments",
    );
  });
  it("accounts both nodes under one condition ceiling and retains unknown reservations", () => {
    const db = new DatabaseSync(":memory:");
    const ledger = new StudyLedger(db, { providerUsd: 10, toolCalls: 100, wallMs: 1000 });
    const charge = {
      id: "a",
      condition: "pooled",
      node: "a",
      phase: "acquisition",
      quote: { providerUsd: 6, toolCalls: 1, wallMs: 1 },
    };
    ledger.reserve(charge);
    ledger.reserve(charge);
    expect(() => ledger.reserve({ ...charge, id: "b", node: "b" })).toThrow("ceiling");
    const row: PairedObservation = {
      taskId: "t",
      family: "f",
      node: "a",
      user: "u",
      environment: "e",
      condition: "pooled",
      phase: "acquisition",
      success: null,
      checked: false,
      criticalFailure: false,
      retention: false,
      freshSession: true,
      elapsedHours: 0,
      newUser: false,
      cost: null,
      tokens: 0,
      latencyMs: 1,
      humanUsefulness: null,
      humanRecommendation: null,
    };
    ledger.finish("a", row, null);
    expect(ledger.unresolved()).toBe(1);
    expect(() => ledger.reserve({ ...charge, id: "b", node: "b" })).toThrow("ceiling");
    expect(() =>
      ledger.finish("a", { ...row, cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 } }, null),
    ).toThrow("Conflicting");
    db.close();
  });
  it("rejects ambiguous or impossible publication dates before freezing a corpus", () => {
    for (const publishedAt of ["2026-02-04T23:30:00", "2026-02-30T09:00:00Z"]) {
      const corpus = createPilotCorpus();
      corpus.tasks[0].input.sources[0].publishedAt = publishedAt;
      expect(() => validateCorpus(corpus)).toThrow();
    }
  });
  it("never silently repeats a paid command after an uncertain response", () => {
    const db = new DatabaseSync(":memory:"),
      ledger = new StudyLedger(db, { providerUsd: 100, toolCalls: 100, wallMs: 1000 });
    expect(ledger.startCommand("paid", { task: "x" })).toBeUndefined();
    expect(() => ledger.startCommand("paid", { task: "x" })).toThrow("reconcile");
    ledger.finishCommand("paid", { passed: false });
    expect(ledger.startCommand("paid", { task: "x" })).toEqual({ passed: false });
    expect(() => ledger.startCommand("paid", { task: "different" })).toThrow("different input");
    db.close();
  });
  it("requires every scheduled final and retention execution in all four arms", () => {
    const tasks = createPilotCorpus().tasks;
    expect(missingFinalCoverage([], tasks)).toBe(480);
    const task = tasks.find((t) => t.partition === "final")!;
    const row: PairedObservation = {
      taskId: task.id,
      family: task.family,
      node: task.node,
      user: task.user,
      environment: task.environment,
      condition: "pooled",
      phase: "final",
      success: true,
      checked: true,
      criticalFailure: false,
      retention: false,
      freshSession: true,
      elapsedHours: 0,
      newUser: task.newUser,
      cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
      tokens: 0,
      latencyMs: 0,
      humanUsefulness: null,
      humanRecommendation: null,
    };
    expect(missingFinalCoverage([row], tasks)).toBe(479);
    expect(missingFinalCoverage([{ ...row, checked: false }], tasks)).toBe(480);
    expect(() => missingFinalCoverage([{ ...row, user: "invented" }], tasks)).toThrow(
      "frozen task identity",
    );
  });
});
