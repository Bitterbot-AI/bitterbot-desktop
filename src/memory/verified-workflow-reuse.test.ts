import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { learningHash, type LearningAdapter } from "./procedural-learning-contract.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProceduralLearning } from "./procedural-learning.js";
import { VerifiedWorkflowReuse, prioritizeWorkflowPractice } from "./verified-workflow-reuse.js";
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  const store = new ProceduralLearningStore(db, { mode: "shadow" });
  const scope = {
    tool: "workflow",
    operation: "report",
    version: "1",
    contractHash: learningHash("contract"),
  };
  const service = new ProceduralLearning(store),
    reuse = new VerifiedWorkflowReuse(service);
  const budget = { providerUsd: 10, toolCalls: 100, wallMs: 100000 };
  let scale = 2,
    executions = 0,
    invalid = false;
  const adapter: LearningAdapter = {
    id: "report",
    scope,
    isolation: "sandbox",
    verifierHash: learningHash("oracle"),
    qualificationCases: [1, 2],
    quote: () => ({ providerUsd: 0, toolCalls: 1, wallMs: 1000 }),
    execute: async (program, input) => {
      executions++;
      return {
        output: (Number(input) * Number(program) * scale) / 2,
        cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
      };
    },
    verify: async (input, output) => ({
      passed: !invalid && output === Number(input) * 2,
      classification: invalid
        ? "verifier-invalid"
        : output === Number(input) * 2
          ? "pass"
          : "candidate-failure",
      cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
    }),
  };
  reuse.register({
    adapter,
    inputContractHash: learningHash("number"),
    accepts: (x) => typeof x === "number" && Number.isFinite(x),
  });
  store.recordEpisode({
    id: "source",
    scope,
    outcome: "failure",
    traceHash: learningHash("source"),
    cost: { providerUsd: 0.1, toolCalls: 1, wallMs: 1 },
    partition: "acquisition",
    sharing: "private",
    occurredAt: Date.now(),
  });
  const entry = store.propose({
    schemaVersion: 1,
    scope,
    lesson: "double",
    program: "2",
    adapter: "report",
    parents: [],
    sourceEpisodes: ["source"],
    origin: "experience",
    sharing: "private",
    counterexamples: ["Other versions unknown"],
    expiresAt: Date.now() + 86400000,
  });
  const request = {
    scope,
    candidate: entry.hash,
    budget,
    predictedSuccess: 0.7,
    shadowEvaluation: true as const,
  };
  const run = { ...request, requestId: "r1", input: 3, partition: "held-out" as const };
  return {
    db,
    store,
    service,
    reuse,
    adapter,
    scope,
    entry,
    request,
    run,
    executions: () => executions,
    drift: () => {
      scale = 3;
    },
    invalidate: () => {
      invalid = true;
    },
  };
}
describe("verified workflow reuse", () => {
  it("withholds unqualified candidates and does not execute on a miss", async () => {
    const s = fixture();
    expect((await s.reuse.reuse(s.run)).disposition).toBe("fallback");
    expect(s.executions()).toBe(0);
  });
  it("executes and independently verifies a retained artifact, recording provenance", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    const r = await s.reuse.reuse(s.run);
    expect(r).toMatchObject({ disposition: "verified-output", candidate: s.entry.hash, output: 6 });
    const row = s.db.prepare("SELECT result FROM workflow_reuse").get() as { result: string };
    expect(JSON.parse(row.result)).toMatchObject({ outputHash: learningHash(6), runId: r.runId });
    expect(row.result).not.toContain('"output":');
  });
  it("rejects changed tool versions before dispatch", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    const n = s.executions();
    expect((await s.reuse.reuse({ ...s.run, scope: { ...s.scope, version: "2" } })).reason).toBe(
      "scope-unavailable",
    );
    expect(s.executions()).toBe(n);
  });
  it("rejects invalid inputs before dispatch", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    expect((await s.reuse.reuse({ ...s.run, input: "3" })).reason).toBe("input-contract-mismatch");
    expect(s.executions()).toBe(2);
  });
  it("catches silent drift and withholds plausible bad output", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    s.drift();
    const r = await s.reuse.reuse(s.run);
    expect(r.disposition).toBe("fallback");
    expect(r.output).toBeUndefined();
    expect(s.store.get(s.entry.hash)?.state).toBe("candidate");
    expect(s.reuse.available(s.scope)).toEqual([]);
    const count = s.executions();
    expect((await s.reuse.reuse({ ...s.run, requestId: "after-failure" })).reason).toBe(
      "no-qualified-workflow",
    );
    expect(s.executions()).toBe(count);
    await expect(s.service.qualify(s.request)).rejects.toThrow("Verifier revision blocked");
    expect(s.store.revoked(s.entry.hash)).toBe(false);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM learning_runs").get()?.n).toBe(3);
  });
  it("stops on invalid verification instead of treating it as learned failure", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    s.invalidate();
    expect((await s.reuse.reuse(s.run)).disposition).toBe("stopped");
    expect(s.reuse.available(s.scope)).toEqual([]);
    expect(s.store.revoked(s.entry.hash)).toBe(false);
  });
  it("never implicitly replays a recorded workflow request", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    await s.reuse.reuse(s.run);
    const n = s.executions();
    await expect(s.reuse.reuse(s.run)).rejects.toThrow("already recorded");
    expect(s.executions()).toBe(n);
  });
  it("cannot trust a verified flag without current qualification receipts", async () => {
    const s = fixture();
    s.db.prepare("UPDATE learning_entries SET state='verified'").run();
    expect(s.reuse.available(s.scope)).toEqual([]);
  });
  it("does not carry qualification across verifier revisions", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    const fresh = new VerifiedWorkflowReuse(new ProceduralLearning(s.store));
    fresh.register({
      adapter: { ...s.adapter, verifierHash: learningHash("new oracle") },
      inputContractHash: learningHash("number"),
      accepts: () => true,
    });
    expect(fresh.available(s.scope)).toEqual([]);
  });
  it("requires new qualification when the input contract changes with the same checker", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    const fresh = new VerifiedWorkflowReuse(new ProceduralLearning(s.store));
    fresh.register({
      adapter: s.adapter,
      inputContractHash: learningHash("positive numbers only, revised"),
      accepts: (x) => typeof x === "number" && x > 0,
    });
    expect(fresh.available(s.scope)).toEqual([]);
    expect((await fresh.reuse({ ...s.run, requestId: "new-contract" })).disposition).toBe(
      "fallback",
    );
    expect(s.executions()).toBe(2);
  });
  it("keeps revocations effective after dream replay", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    s.store.revoke(s.entry.hash, "drift");
    s.service.replay();
    expect(s.reuse.available(s.scope)).toEqual([]);
  });
  it("charges shared acquisition and each check against the same budget", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    await expect(
      s.reuse.reuse({ ...s.run, budget: { ...s.request.budget, toolCalls: 3 } }),
    ).rejects.toThrow("budget");
    expect(s.executions()).toBe(2);
  });
  it("does not expose shadow lessons to ordinary retrieval", async () => {
    const s = fixture();
    await s.service.qualify(s.request);
    expect(s.service.lookup(s.scope).lessons).toEqual([]);
    expect(s.reuse.available(s.scope)).toHaveLength(1);
  });
  it("rejects non-shadow configuration", () => {
    const db = new DatabaseSync(":memory:");
    open.push(db);
    expect(
      () =>
        new VerifiedWorkflowReuse(
          new ProceduralLearning(new ProceduralLearningStore(db, { mode: "active" })),
        ),
    ).toThrow("only in shadow");
  });
  it("prioritizes declared useful uncertain opportunities and rejects malformed evidence", () => {
    expect(
      prioritizeWorkflowPractice([
        { id: "a", expectedUses: 1, successes: 8, failures: 0, quotedCost: 1 },
        { id: "b", expectedUses: 6, successes: 1, failures: 1, quotedCost: 1 },
      ]),
    ).toEqual(["b", "a"]);
    expect(() =>
      prioritizeWorkflowPractice([
        { id: "x", expectedUses: 1, successes: -1, failures: 0, quotedCost: 1 },
      ]),
    ).toThrow();
  });
});
