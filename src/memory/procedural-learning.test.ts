import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import {
  LearningConfigSchema,
  learningHash,
  type LearningAdapter,
  type LearningCandidate,
} from "./procedural-learning-contract.js";
import { exportLearningPacket, importLearningPacket } from "./procedural-learning-peer.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProceduralLearning, rankLearningInvestigations } from "./procedural-learning.js";
import { SkillNetworkBridge } from "./skill-network-bridge.js";

const scope = {
  tool: "fixture",
  version: "2",
  operation: "scale",
  contractHash: learningHash("scale-v2"),
};
const budget = { providerUsd: 10, toolCalls: 100, wallMs: 100000 };
const resources: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of resources.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(config: Parameters<typeof LearningConfigSchema.parse>[0] = {}, file = ":memory:") {
  let now = 100000;
  const db = new DatabaseSync(file);
  resources.push(db);
  const store = new ProceduralLearningStore(db, LearningConfigSchema.parse(config), () => now);
  const service = new ProceduralLearning(store);
  const adapter: LearningAdapter = {
    id: "scale-v2",
    scope,
    isolation: "sandbox",
    verifierHash: learningHash("oracle-v1"),
    qualificationCases: [1, -2],
    quote: () => ({ providerUsd: 0, toolCalls: 2, wallMs: 1000 }),
    execute: async (program, input) => ({
      output: Number(input) * Number(program),
      cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
    }),
    verify: async (input, output) => ({
      passed: output === Number(input) * 3,
      cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
    }),
  };
  service.registerAdapter(adapter);
  store.recordEpisode({
    id: "e1",
    scope,
    outcome: "failure",
    traceHash: learningHash("failure"),
    cost: { providerUsd: 0.02, toolCalls: 1, wallMs: 1 },
    partition: "acquisition",
    sharing: "shareable",
    occurredAt: now,
  });
  const candidate: LearningCandidate = {
    schemaVersion: 1,
    scope,
    lesson: "Version 2 scales by three",
    adapter: adapter.id,
    program: "3",
    counterexamples: ["Version 1 scales by two"],
    parents: [],
    sourceEpisodes: ["e1"],
    origin: "experience",
    sharing: "shareable",
    expiresAt: now + 86400000,
  };
  const entry = store.propose(candidate);
  const request = {
    candidate: entry.hash,
    scope,
    budget,
    predictedSuccess: 0.8,
    shadowEvaluation: true,
  };
  return {
    db,
    store,
    service,
    adapter,
    candidate,
    entry,
    request,
    setNow: (value: number) => {
      now = value;
    },
  };
}
function envelope(content: string): SkillEnvelope {
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(content);
  return {
    version: 1,
    skill_md: bytes.toString("base64"),
    name: "procedure",
    author_peer_id: "peer",
    author_pubkey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64"),
    signature: sign(null, bytes, keys.privateKey).toString("base64"),
    timestamp: 100000,
    content_hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("verified procedural learning", () => {
  it("encodes a qualified candidate for the orchestrator wire contract", async () => {
    const s = setup({ mode: "active" });
    await s.service.qualify(s.request);
    const publishSkill = vi.fn(async () => ({ ok: true }));
    const bridge = new SkillNetworkBridge(s.db, { publishSkill });
    bridge.setProceduralLearning(() => s.service);
    await bridge.publishLearningCandidate(s.entry.hash);
    const expected = exportLearningPacket(s.store, s.entry.hash);
    expect(publishSkill).toHaveBeenCalledWith(
      Buffer.from(expected, "utf8").toString("base64"),
      `verified-procedure-${s.entry.hash.slice(0, 12)}`,
    );
  });
  it("quarantines invalid verification without revoking procedures or calibrating it as failure", async () => {
    const s = setup();
    await s.service.qualify(s.request);
    const child = s.store.propose({ ...s.candidate, lesson: "dependent", parents: [s.entry.hash] });
    const invalid = new ProceduralLearning(s.store);
    invalid.registerAdapter({
      ...s.adapter,
      verify: async () => ({
        passed: false,
        classification: "verifier-invalid",
        cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
      }),
    });
    const result = await invalid.run({ ...s.request, input: 1, partition: "acquisition" });
    expect(result.classification).toBe("verifier-invalid");
    expect(s.store.get(s.entry.hash)?.state).toBe("candidate");
    expect(s.store.get(child.hash)?.state).toBe("candidate");
    expect(s.store.revoked(s.entry.hash)).toBe(false);
    expect(s.store.retrieve(scope, true)).toEqual([]);
    expect(() => exportLearningPacket(s.store, s.entry.hash)).toThrow();
    expect(invalid.status().calibration).toEqual([
      expect.objectContaining({ n: 2, verifiedSuccess: 1 }),
    ]);
    await expect(invalid.qualify(s.request)).rejects.toThrow("Verifier revision blocked");
    const repaired = new ProceduralLearning(s.store);
    repaired.registerAdapter({ ...s.adapter, verifierHash: learningHash("oracle-v2") });
    expect(await repaired.qualify(s.request)).toBe(true);
    expect(s.store.get(child.hash)?.state).toBe("candidate");
  });
  it("qualifies independent procedures without discarding a passing sibling", async () => {
    const s = setup();
    const bad = s.store.propose({ ...s.candidate, program: "2", lesson: "incorrect sibling" });
    expect(await s.service.qualify({ ...s.request, candidate: bad.hash })).toBe(false);
    expect(await s.service.qualify(s.request)).toBe(true);
    expect(s.store.get(bad.hash)?.state).toBe("revoked");
    expect(s.store.get(s.entry.hash)?.state).toBe("verified");
    expect(s.store.costs().toolCalls).toBe(7);
  });
  it("keeps known resource overruns charged without treating them as semantic failures", async () => {
    const s = setup();
    const limited = new ProceduralLearning(s.store);
    limited.registerAdapter({
      ...s.adapter,
      execute: async () => ({ output: 3, cost: { providerUsd: 0.1, toolCalls: 3, wallMs: 1 } }),
    });
    const result = await limited.run({ ...s.request, input: 1, partition: "acquisition" });
    expect(result.classification).toBe("resource-exhausted");
    expect(s.store.costs()).toMatchObject({ toolCalls: 4, unknownRuns: 0 });
    expect(s.store.costs().providerUsd).toBeCloseTo(0.12);
    expect(s.store.get(s.entry.hash)?.state).toBe("candidate");
    expect(limited.status().calibration).toEqual([]);
  });
  it("preserves verifier exceptions and unknown costs through reconciliation", async () => {
    const s = setup();
    const broken = new ProceduralLearning(s.store);
    broken.registerAdapter({
      ...s.adapter,
      verify: async () => {
        throw new Error("fixture unavailable");
      },
    });
    const result = await broken.run({ ...s.request, input: 1, partition: "acquisition" });
    expect(result.classification).toBe("verifier-invalid");
    expect(s.store.costs().unknownRuns).toBe(1);
    s.store.reconcileRun(result.runId, { providerUsd: 0.03, toolCalls: 2, wallMs: 1 });
    expect(broken.status().calibration).toEqual([]);
    expect(s.store.revoked(s.entry.hash)).toBe(false);
    await expect(broken.qualify(s.request)).rejects.toThrow("Verifier revision blocked");
  });
  it("rejects internally inconsistent trusted verdicts", async () => {
    const s = setup();
    const broken = new ProceduralLearning(s.store);
    broken.registerAdapter({
      ...s.adapter,
      verify: async () => ({
        passed: true,
        classification: "candidate-failure",
        cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
      }),
    });
    const result = await broken.run({ ...s.request, input: 1, partition: "acquisition" });
    expect(result).toMatchObject({ passed: false, classification: "verifier-invalid" });
    expect(s.store.get(s.entry.hash)?.state).toBe("candidate");
  });
  it("keeps one passing observation unqualified; requires a complete host panel", async () => {
    const s = setup();
    await s.service.run({ ...s.request, input: 1, partition: "acquisition" });
    expect(s.store.get(s.entry.hash)?.state).toBe("candidate");
    expect(await s.service.qualify(s.request)).toBe(true);
    expect(s.store.get(s.entry.hash)?.state).toBe("verified");
    expect(s.service.lookup(scope)).toMatchObject({ lessons: [], shadowMatches: 1 });
    await expect(
      s.service.run({ ...s.request, input: 7, partition: "held-out", shadowEvaluation: false }),
    ).rejects.toThrow("shadow");
  });
  it("retrieves qualified lessons only for the exact active contract and version", async () => {
    const s = setup({ mode: "active" });
    await s.service.qualify(s.request);
    expect(s.service.lookup(scope).lessons).toHaveLength(1);
    for (const variant of [
      { ...scope, version: "3" },
      { ...scope, operation: "other" },
      { ...scope, contractHash: learningHash("different") },
    ]) {
      expect(s.service.lookup(variant).lessons).toHaveLength(0);
      await expect(
        s.service.run({ ...s.request, scope: variant, input: 8, partition: "held-out" }),
      ).rejects.toThrow("scope");
    }
  });
  it("never promotes held-out success or learns from held-out failures", async () => {
    const s = setup();
    await s.service.run({ ...s.request, input: 7, partition: "held-out" });
    expect(s.store.get(s.entry.hash)?.state).toBe("candidate");
    await expect(s.service.run({ ...s.request, input: 1, partition: "held-out" })).rejects.toThrow(
      "overlap",
    );
    s.store.recordEpisode({ ...s.store.episode("e1")!, id: "held", partition: "held-out" });
    expect(() => s.store.propose({ ...s.candidate, sourceEpisodes: ["held"] })).toThrow("held-out");
  });
  it("rejects self-reported verification and foreign evidence", () => {
    const s = setup();
    expect(() => s.store.propose({ ...s.candidate, verified: true })).toThrow();
    expect(() => s.store.propose({ ...s.candidate, scope: { ...scope, version: "1" } })).toThrow(
      "unrelated",
    );
    expect(() => s.store.propose({ ...s.candidate, sourceEpisodes: ["missing"] })).toThrow(
      "Missing",
    );
  });
  it("catches incorrect execution despite apparent success and withholds its output", async () => {
    const s = setup();
    const bad = s.store.propose({ ...s.candidate, program: "2" });
    const result = await s.service.run({
      ...s.request,
      candidate: bad.hash,
      input: 4,
      partition: "acquisition",
    });
    expect(result).toMatchObject({ passed: false });
    expect(result.output).toBeUndefined();
    expect(s.store.get(bad.hash)?.state).toBe("revoked");
    expect(s.store.costs().toolCalls).toBe(3);
  });
  it("cascades revocation through descendants and dream replay cannot restore them", async () => {
    const s = setup();
    await s.service.qualify(s.request);
    const child = s.store.propose({
      ...s.candidate,
      lesson: "Revised",
      parents: [s.entry.hash],
      origin: "dream",
    });
    const grandchild = s.store.propose({
      ...s.candidate,
      lesson: "Revised twice",
      parents: [child.hash],
      origin: "dream",
    });
    s.store.revoke(s.entry.hash, "tool drift");
    s.service.replay();
    expect(s.store.usable(grandchild.hash)).toBe(false);
    expect(s.store.get(child.hash)?.state).toBe("revoked");
    expect(() => s.store.propose(s.candidate)).toThrow("Revoked");
  });
  it("does not manufacture evidence during consolidation, and expires lessons", async () => {
    const s = setup();
    await s.service.qualify(s.request);
    const before = s.store.costs();
    s.service.replay();
    s.service.replay();
    expect(s.store.costs()).toEqual(before);
    s.setNow(s.candidate.expiresAt);
    expect(s.service.replay().expired).toBe(1);
    expect(s.store.retrieve(scope, true)).toHaveLength(0);
  });
  it("preserves evidence across a real database close/reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learning-"));
    dirs.push(dir);
    const file = join(dir, "memory.sqlite");
    const s = setup({}, file);
    await s.service.qualify(s.request);
    const costs = s.store.costs();
    s.db.close();
    const db = new DatabaseSync(file);
    resources.push(db);
    const reopened = new ProceduralLearningStore(db, {}, () => 100001);
    expect(reopened.retrieve(scope, true)).toHaveLength(1);
    expect(reopened.costs()).toEqual(costs);
  });
  it("charges acquisition and verification against the same total ceiling", async () => {
    const s = setup();
    await expect(
      s.service.qualify({ ...s.request, budget: { ...budget, toolCalls: 2 } }),
    ).rejects.toThrow("budget");
    expect(s.store.costs().toolCalls).toBe(1);
    expect(await s.service.qualify({ ...s.request, budget: { ...budget, toolCalls: 5 } })).toBe(
      true,
    );
    expect(s.store.costs().toolCalls).toBe(5);
  });
  it("keeps unknown costs unresolved and cannot silently retry after interruption", async () => {
    const s = setup();
    const service = new ProceduralLearning(s.store);
    service.registerAdapter({
      ...s.adapter,
      execute: async () => {
        throw new Error("connection lost after charge");
      },
    });
    const result = await service.run({ ...s.request, input: 5, partition: "acquisition" });
    expect(result.passed).toBe(false);
    expect(s.store.costs().unknownRuns).toBe(1);
    await expect(service.run({ ...s.request, input: 6, partition: "acquisition" })).rejects.toThrow(
      "Unresolved",
    );
    s.store.reconcileRun(result.runId, { providerUsd: 0.01, toolCalls: 1, wallMs: 4 });
    expect(s.store.costs().unknownRuns).toBe(0);
    expect(s.store.get(s.entry.hash)?.state).toBe("candidate");
    expect(() =>
      s.store.reconcileRun(result.runId, { providerUsd: 0, toolCalls: 0, wallMs: 0 }),
    ).toThrow();
  });
  it("requires accounting for unpriced source episodes", async () => {
    const s = setup();
    s.store.recordEpisode({ ...s.store.episode("e1")!, id: "unknown", cost: null });
    await expect(s.service.qualify(s.request)).rejects.toThrow("Unresolved");
    s.store.reconcileEpisode("unknown", { providerUsd: 0.1, toolCalls: 1, wallMs: 1 });
    expect(await s.service.qualify(s.request)).toBe(true);
    expect(s.store.costs().providerUsd).toBeCloseTo(0.12);
  });
  it("quarantines signed peer packages without transferring local trust", async () => {
    const s = setup();
    await s.service.qualify(s.request);
    const packet = envelope(exportLearningPacket(s.store, s.entry.hash));
    const recipient = setup();
    const imported = importLearningPacket(recipient.store, packet);
    expect(recipient.store.get(imported)?.state).toBe("candidate");
    expect(recipient.store.retrieve(scope, true)).toHaveLength(0);
    expect(await recipient.service.qualify({ ...recipient.request, candidate: imported })).toBe(
      true,
    );
    expect(importLearningPacket(recipient.store, packet)).toBe(imported);
    expect(recipient.store.costs().toolCalls).toBe(5);
    expect(() => importLearningPacket(recipient.store, { ...packet, signature: "bad" })).toThrow(
      "signature",
    );
  });
  it("does not export private source material or accept missing ancestry", async () => {
    const s = setup();
    s.store.recordEpisode({ ...s.store.episode("e1")!, id: "private", sharing: "private" });
    expect(() => s.store.propose({ ...s.candidate, sourceEpisodes: ["private"] })).toThrow(
      "Private",
    );
    const imported = s.store.propose(
      { ...s.candidate, parents: [learningHash("missing-parent")] },
      true,
    );
    expect(s.store.usable(imported.hash)).toBe(false);
    expect(() => exportLearningPacket(s.store, imported.hash)).toThrow();
  });
  it("bounds storage, validates configuration, and deduplicates exact observations", () => {
    const s = setup({ maxEntries: 1 });
    expect(s.store.propose(s.candidate).hash).toBe(s.entry.hash);
    expect(() => s.store.propose({ ...s.candidate, lesson: "second" })).toThrow("capacity");
    expect(() => s.store.recordEpisode({ ...s.store.episode("e1")!, outcome: "success" })).toThrow(
      "collision",
    );
    expect(() => LearningConfigSchema.parse({ mode: "automatic" })).toThrow();
    expect(learningHash({ a: 1, b: 2 })).toBe(learningHash({ b: 2, a: 1 }));
  });
  it("records forecasts separately from evidence", async () => {
    const s = setup();
    await s.service.run({ ...s.request, input: 5, partition: "held-out" });
    expect(s.service.status().calibration).toEqual([
      expect.objectContaining({ partition: "held-out", n: 1, brier: expect.closeTo(0.04) }),
    ]);
    expect(
      rankLearningInvestigations([
        { id: "useful", expectedUses: 10, predictedGain: 0.2, valuePerSuccess: 1, totalCost: 1 },
        { id: "novel", expectedUses: 0, predictedGain: 1, valuePerSuccess: 1, totalCost: 1 },
      ]),
    ).toEqual([{ id: "useful", expectedNetValue: 1 }]);
  });
});
