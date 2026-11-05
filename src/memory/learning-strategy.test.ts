import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { LearningStrategySchema, type StrategyPanel } from "./learning-strategy-contract.js";
import { exportStrategyPacket, importStrategyPacket } from "./learning-strategy-peer.js";
import { learningHash, type LearningCost } from "./procedural-learning-contract.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import { ProceduralLearning } from "./procedural-learning.js";

const services: ProceduralLearning[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});
const scope = {
  tool: "strategy-test",
  version: "1",
  operation: "scale",
  contractHash: learningHash("contract"),
};
const budget: LearningCost = { providerUsd: 10, toolCalls: 100, wallMs: 100000 };
const zero = { providerUsd: 0, toolCalls: 0, wallMs: 0 };
function setup(mode: "shadow" | "active" | "off" = "shadow", database = ":memory:") {
  let now = 100000;
  const service = new ProceduralLearning(
    new ProceduralLearningStore(new DatabaseSync(database), { mode }, () => now),
  );
  services.push(service);
  const lab = service.strategies;
  const seed = {
    schemaVersion: 1 as const,
    scope,
    actor: "2",
    proposer: "Use measured failures",
    parents: [],
    sharing: "shareable" as const,
    expiresAt: now + 86400000,
  };
  const panel: StrategyPanel = {
    id: "dev",
    scope,
    partition: "development",
    model: "fixture",
    verifierHash: learningHash("oracle"),
    isolation: "sandbox",
    cases: [
      { id: "a", input: 1 },
      { id: "b", input: 2 },
    ],
    quote: () => ({ providerUsd: 0.2, toolCalls: 2, wallMs: 1000 }),
    execute: async (strategy, input) => ({
      output: Number(input) * Number(strategy.actor),
      cost: { ...zero, providerUsd: 0.01, toolCalls: 1 },
    }),
    verify: async (input, output) => ({
      passed: output === Number(input) * 3,
      cost: { ...zero, toolCalls: 1 },
      feedback: `input=${String(input)},output=${String(output)}`,
    }),
  };
  return {
    service,
    lab,
    seed,
    panel,
    setNow: (value: number) => {
      now = value;
    },
  };
}
it("requires shadow mode and rejects permission/verifier edits", () => {
  const { lab, seed } = setup("active");
  expect(() => lab.archive.add(seed)).toThrow("shadow-only");
  expect(() => LearningStrategySchema.parse({ ...seed, permissions: ["*"] })).toThrow();
});
it("keeps losing branches while ranking measured complete development results", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel(panel);
  const first = lab.archive.add(seed),
    better = lab.archive.add({ ...seed, actor: "3", parents: [first] });
  expect((await lab.evaluate(first, "dev", budget)).score).toBe(0);
  expect((await lab.evaluate(better, "dev", budget)).score).toBe(1);
  expect(lab.archive.rank("dev").map((r) => r.strategy)).toEqual([better, first]);
  expect(service.store.costs().providerUsd).toBeCloseTo(0.04);
  expect(
    service.store.db.prepare("SELECT COUNT(*) AS n FROM learning_entries").get(),
  ).toMatchObject({ n: 0 });
});
it("pins panel identity and rejects training/test input overlap", () => {
  const { lab, panel } = setup();
  lab.registerPanel(panel);
  expect(() => lab.registerPanel({ ...panel, id: "test", partition: "held-out" })).toThrow(
    "overlap",
  );
  expect(() => lab.registerPanel({ ...panel, model: "changed" })).toThrow("identity changed");
});
it("seals search before final evaluation and never selects on held-out outcomes", async () => {
  const { lab, seed, panel } = setup();
  lab.registerPanel(panel);
  lab.registerPanel({
    ...panel,
    id: "test",
    partition: "held-out",
    cases: [
      { id: "c", input: 3 },
      { id: "d", input: 4 },
    ],
  });
  const hash = lab.archive.add(seed);
  await expect(lab.evaluate(hash, "test", budget)).rejects.toThrow("frozen");
  await lab.evaluate(hash, "dev", budget);
  lab.archive.seal(scope, [hash]);
  await lab.evaluate(hash, "test", budget);
  expect(() => lab.archive.rank("test")).toThrow("development");
  await expect(lab.evaluate(hash, "dev", budget)).rejects.toThrow("sealed");
  await expect(lab.evaluate(hash, "test", budget)).rejects.toThrow("already evaluated");
  expect(() => lab.archive.add({ ...seed, actor: "3" })).toThrow("sealed");
});
it("preserves unknown costs and excludes incomplete batches after verifier failure", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel({
    ...panel,
    verify: async () => {
      throw new Error("broken oracle");
    },
  });
  const hash = lab.archive.add(seed);
  await expect(lab.evaluate(hash, "dev", budget)).rejects.toThrow("broken oracle");
  expect(lab.archive.rank("dev")).toEqual([]);
  expect(service.store.costs().unknownRuns).toBe(1);
  await expect(lab.evaluate(hash, "dev", budget)).rejects.toThrow("Unresolved");
  expect(() => lab.archive.seal(scope, [hash])).toThrow("unresolved");
});
it("charges cost overruns and never ranks the partial result", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel({
    ...panel,
    execute: async () => ({ output: 3, cost: { ...zero, providerUsd: 1 } }),
  });
  const hash = lab.archive.add(seed);
  await expect(lab.evaluate(hash, "dev", budget)).rejects.toThrow("reservation");
  expect(service.store.costs().providerUsd).toBe(1);
  expect(service.store.costs().unknownRuns).toBe(0);
  expect(lab.archive.rank("dev")).toEqual([]);
});
it("meters proposals, allows proposer evolution, and holds the control proposer fixed", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel(panel);
  const parent = lab.archive.add(seed);
  await lab.evaluate(parent, "dev", budget);
  const seen: string[] = [];
  const params = {
    parent,
    panel: "dev",
    fixedProposer: "fixed",
    quote: { providerUsd: 0.1, toolCalls: 0, wallMs: 1000 },
    budget,
    generate: async (context: { instructions: string; feedback: string[] }) => {
      seen.push(context.instructions);
      expect(context.feedback).toHaveLength(2);
      return {
        edit: { actor: "3", proposer: "Compare failures" },
        cost: { ...zero, providerUsd: 0.02 },
      };
    },
  };
  const fixed = await lab.propose({ ...params, evolveProposer: false }),
    evolved = await lab.propose({ ...params, evolveProposer: true });
  expect(seen).toEqual(["fixed", seed.proposer]);
  expect(lab.archive.get(fixed)?.proposer).toBe("fixed");
  expect(lab.archive.get(evolved)?.proposer).toBe("Compare failures");
  expect(lab.archive.rank("dev")).toHaveLength(1);
  expect(service.store.costs().providerUsd).toBeCloseTo(0.06);
});
it("charges malformed proposals without fabricating behavioral evidence", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel(panel);
  const parent = lab.archive.add(seed);
  await lab.evaluate(parent, "dev", budget);
  await expect(
    lab.propose({
      parent,
      panel: "dev",
      fixedProposer: "fixed",
      evolveProposer: true,
      quote: { providerUsd: 0.1, toolCalls: 0, wallMs: 1000 },
      budget,
      generate: async () => ({
        edit: { actor: "3", proposer: "hi", verifier: "always pass" },
        cost: { ...zero, providerUsd: 0.01 },
      }),
    }),
  ).rejects.toThrow();
  expect(service.store.costs().unknownRuns).toBe(0);
  expect(service.store.costs().providerUsd).toBeCloseTo(0.03);
  expect(lab.archive.rank("dev")).toHaveLength(1);
});
it("preserves the parent in append mode and charges rejected edits without creating children", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel(panel);
  const parent = lab.archive.add(seed);
  await lab.evaluate(parent, "dev", budget);
  const params = {
    parent,
    panel: "dev",
    editMode: "append" as const,
    evolveProposer: false,
    fixedProposer: seed.proposer,
    quote: { providerUsd: 0.1, toolCalls: 0, wallMs: 1000 },
    budget,
  };
  const child = await lab.propose({
    ...params,
    generate: async () => ({ edit: { append: "Verify the observed result." }, cost: zero }),
  });
  expect(lab.archive.get(child)).toMatchObject({
    actor: seed.actor + "\n\nVerify the observed result.",
    proposer: seed.proposer,
    parents: [parent],
    sharing: "private",
  });
  for (const edit of [
    { append: "x".repeat(601) },
    { actor: "replace", proposer: "replace" },
    { append: "ok", proposer: "change" },
    { append: " " },
  ]) {
    await expect(
      lab.propose({
        ...params,
        generate: async () => ({ edit, cost: { ...zero, providerUsd: 0.01 } }),
      }),
    ).rejects.toThrow();
  }
  expect(service.store.costs().providerUsd).toBeCloseTo(0.06);
  expect(service.store.costs().unknownRuns).toBe(0);
  expect(lab.archive.rank("dev")).toHaveLength(1);
  await expect(
    lab.propose({
      ...params,
      evolveProposer: true,
      generate: async () => {
        throw new Error("Must not dispatch");
      },
    }),
  ).rejects.toThrow("fixed proposer");
  const largeParent = lab.archive.add({ ...seed, actor: "x".repeat(3999) });
  await lab.evaluate(largeParent, "dev", budget);
  await expect(
    lab.propose({
      ...params,
      parent: largeParent,
      generate: async () => ({ edit: { append: "overflow" }, cost: zero }),
    }),
  ).rejects.toThrow();
});
it("pins a bounded feedback limit without exposing held-out feedback", async () => {
  const { lab, seed, panel } = setup();
  const feedback = "x".repeat(7000) + "observed final result";
  const richPanel = {
    ...panel,
    feedbackLimit: 32000,
    verify: async () => ({ passed: true, cost: zero, feedback }),
  };
  for (const feedbackLimit of [0, 32001, 1.5, NaN])
    expect(() => lab.registerPanel({ ...richPanel, feedbackLimit })).toThrow("Invalid");
  lab.registerPanel(richPanel);
  const parent = lab.archive.add(seed);
  await lab.evaluate(parent, "dev", budget);
  expect(lab.archive.feedback("dev", parent)).toEqual([feedback, feedback]);
  expect(() => lab.registerPanel({ ...richPanel, feedbackLimit: 6000 })).toThrow("identity");
  lab.registerPanel({
    ...richPanel,
    id: "held",
    partition: "held-out",
    cases: [
      { id: "c", input: 3 },
      { id: "d", input: 4 },
    ],
  });
  lab.archive.seal(scope, [parent]);
  await lab.evaluate(parent, "held", budget);
  expect(() => lab.archive.feedback("held", parent)).toThrow("development");
});
it("preserves actor text in conditional edits and rejects unsupported host vocabularies", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel(panel);
  const parent = lab.archive.add(seed);
  await lab.evaluate(parent, "dev", budget);
  const reminders = [
    {
      id: "check",
      when: [{ fact: "device.enabled", is: "unknown" as const }],
      text: "Check the switch.",
    },
  ];
  const child = await lab.propose({
    parent,
    panel: "dev",
    editMode: "conditional",
    evolveProposer: false,
    fixedProposer: seed.proposer,
    budget,
    quote: { providerUsd: 0.1, toolCalls: 0, wallMs: 1000 },
    generate: async () => ({ edit: { reminders }, cost: zero }),
  });
  expect(lab.archive.get(child)).toMatchObject({
    actor: seed.actor,
    proposer: seed.proposer,
    reminders,
    parents: [parent],
    sharing: "private",
  });
  const before = service.store.costs().providerUsd;
  await expect(lab.evaluate(child, "dev", budget)).rejects.toThrow("vocabulary");
  expect(service.store.costs().providerUsd).toBe(before);
  const facts = ["device.enabled"];
  lab.registerPanel({ ...panel, id: "supported", reminderFacts: facts });
  facts.length = 0;
  expect((await lab.evaluate(child, "supported", budget)).total).toBe(2);
});
it("keeps strategies derived from private evaluation feedback private", async () => {
  const { lab, seed, panel } = setup();
  lab.registerPanel(panel);
  const parent = lab.archive.add(seed);
  await lab.evaluate(parent, "dev", budget);
  const child = await lab.propose({
    parent,
    panel: "dev",
    evolveProposer: true,
    fixedProposer: "fixed",
    quote: { providerUsd: 0.1, toolCalls: 0, wallMs: 1000 },
    budget,
    generate: async () => ({ edit: { actor: "3", proposer: "private lesson" }, cost: zero }),
  });
  expect(lab.archive.get(child)?.sharing).toBe("private");
  await lab.evaluate(child, "dev", budget);
  expect(() => exportStrategyPacket(lab, child, "dev")).toThrow("Private");
});
it("reconstructs evidence in a fresh facade and rejects altered panel identities", async () => {
  const { lab, seed, panel, service } = setup();
  lab.registerPanel(panel);
  const hash = lab.archive.add(seed);
  await lab.evaluate(hash, "dev", budget);
  // A fresh host facade reconstructs archive state from the same durable tables.
  const { LearningStrategyLab } = await import("./learning-strategy.js");
  const reopened = new LearningStrategyLab(service.store);
  reopened.registerPanel(panel);
  expect(reopened.archive.rank("dev")[0].strategy).toBe(hash);
  expect(() =>
    reopened.registerPanel({
      ...panel,
      cases: [
        { id: "a", input: 8 },
        { id: "b", input: 9 },
      ],
    }),
  ).toThrow("identity changed");
  await reopened.close();
});
it("retains strategy evidence and evaluation seals after closing and reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strategy-reopen-"));
  const database = join(directory, "learning.sqlite");
  try {
    const first = setup("shadow", database);
    first.lab.registerPanel(first.panel);
    const hash = first.lab.archive.add(first.seed);
    await first.lab.evaluate(hash, "dev", budget);
    first.lab.archive.seal(scope, [hash]);
    services.splice(services.indexOf(first.service), 1);
    await first.service.close();
    const second = setup("shadow", database);
    second.lab.registerPanel(second.panel);
    expect(second.lab.archive.get(hash)?.actor).toBe(first.seed.actor);
    expect(second.lab.archive.rank("dev")[0].strategy).toBe(hash);
    expect(second.lab.archive.feedback("dev", hash)).toHaveLength(2);
    expect(second.service.store.costs().providerUsd).toBeCloseTo(0.02);
    await expect(second.lab.evaluate(hash, "dev", budget)).rejects.toThrow("sealed");
    services.splice(services.indexOf(second.service), 1);
    await second.service.close();
  } finally {
    for (const service of services.splice(0)) await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("propagates revocation and expiration through strategy ancestry", () => {
  const { lab, seed, setNow } = setup();
  const parent = lab.archive.add({ ...seed, expiresAt: 100010 }),
    child = lab.archive.add({ ...seed, actor: "3", parents: [parent] });
  setNow(100011);
  expect(lab.archive.get(child)).toBeNull();
  const root = lab.archive.add({ ...seed, actor: "4" }),
    next = lab.archive.add({ ...seed, actor: "5", parents: [root] });
  lab.archive.revoke(root);
  expect(lab.archive.get(next)).toBeNull();
});
it("authenticates transfer while withholding source qualifications from recipients", async () => {
  const source = setup(),
    recipient = setup();
  source.lab.registerPanel(source.panel);
  recipient.lab.registerPanel(recipient.panel);
  const hash = source.lab.archive.add(source.seed);
  await source.lab.evaluate(hash, "dev", budget);
  const content = Buffer.from(exportStrategyPacket(source.lab, hash, "dev")),
    keys = generateKeyPairSync("ed25519");
  const envelope = {
    version: 1,
    name: "strategy",
    skill_md: content.toString("base64"),
    content_hash: createHash("sha256").update(content).digest("hex"),
    timestamp: Date.now(),
    author_peer_id: "private-test",
    author_pubkey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64"),
    signature: sign(null, content, keys.privateKey).toString("base64"),
  };
  expect(importStrategyPacket(recipient.lab, envelope)).toBe(hash);
  expect(recipient.lab.archive.rank("dev")).toEqual([]);
  expect(() => exportStrategyPacket(recipient.lab, hash, "dev")).toThrow("Local development");
  expect(() =>
    importStrategyPacket(recipient.lab, { ...envelope, content_hash: "0".repeat(64) }),
  ).toThrow("hash");
  await recipient.lab.evaluate(hash, "dev", budget);
  expect(recipient.lab.archive.rank("dev")).toHaveLength(1);
});
