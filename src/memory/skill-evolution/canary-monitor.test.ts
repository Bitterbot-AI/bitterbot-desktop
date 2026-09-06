/**
 * PLAN-45 Phase 3: the post-promotion monitor end to end. I4: a manufactured
 * production regression is rolled back automatically within ONE
 * housekeeping pass (journal -> canary rows -> decision -> archive/restore
 * -> trail -> registry).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvolutionMeta } from "./validation-gate.js";
import {
  readCanaryRegistry,
  registerCanary,
  resetCanaryRegistryCacheForTest,
} from "../../agents/skills/canary-registry.js";
import { readProvenance } from "../../agents/skills/impact-trail.js";
import {
  archiveVersion,
  liveSkillPath,
  readArchivedVersion,
  readLive,
  resolveStorageRoots,
  stageSkill,
} from "../../agents/skills/skill-storage.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { SkillLifecycleStore } from "../skill-lifecycle.js";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { appendCanaryRuns, type CanaryRunRow, readCanaryRuns } from "./canary-ledger.js";
import {
  buildCanaryWindow,
  evidenceScore,
  retireEvolvedAtCap,
  runCanaryMonitor,
} from "./canary-monitor.js";
import { refreshEvidenceRecords } from "./evidence-record.js";
import { runHousekeeping } from "./housekeeping.js";
import { retractionsPath } from "./p2p-publish.js";

const DAY = 24 * 60 * 60 * 1000;

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db, embeddingCacheTable: "embedding_cache", ftsTable: "chunks_fts" });
  runMigrations(db);
  return db;
}

async function writeEvolved(
  tmp: string,
  name: string,
  meta: Partial<EvolutionMeta>,
  body = "v2 body",
): Promise<string> {
  const roots = resolveStorageRoots({ configDir: tmp });
  const dir = path.dirname(liveSkillPath(roots, name));
  await fs.mkdir(dir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: Use when running curl against flaky hosts that time out\n---\n${body}\n`;
  await fs.writeFile(liveSkillPath(roots, name), content, "utf-8");
  await fs.writeFile(
    path.join(dir, ".evolution-meta.json"),
    JSON.stringify({ origin: "wiki-evolution", ...meta }, null, 2),
    "utf-8",
  );
  return content;
}

function row(partial: Partial<CanaryRunRow> & { runId: string; skill: string }): CanaryRunRow {
  return {
    ts: Date.now(),
    exposed: true,
    read: false,
    eligible: true,
    label: "pass",
    outcomeLevel: 2,
    model: "openai/gpt-x",
    origin: "human",
    credited: true,
    sessionKey: "agent:main:main",
    ...partial,
  };
}

describe("canary monitor (PLAN-45 Phase 3)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "canary-mon-"));
    resetCanaryRegistryCacheForTest();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    resetCanaryRegistryCacheForTest();
  });

  it("buildCanaryWindow: intention-to-treat on lexical eligibility; withheld-but-read rows are contaminated control and count as exposed", () => {
    const rows = [
      row({ runId: "a", skill: "s", read: true, label: "pass" }),
      row({ runId: "b", skill: "s", read: false, label: "fail" }),
      row({ runId: "c", skill: "s", read: true, label: "env-fail" }),
      row({ runId: "d", skill: "s", read: false, eligible: false, label: "pass" }),
      row({ runId: "e", skill: "s", exposed: false, label: "pass" }),
      row({ runId: "f", skill: "s", exposed: false, label: "fail" }),
      row({ runId: "g", skill: "s", exposed: false, eligible: false, label: "pass" }),
      row({ runId: "h", skill: "s", exposed: false, credited: false, label: "pass" }),
      row({ runId: "i", skill: "s", ts: 10, exposed: false, label: "pass" }),
      row({ runId: "j", skill: "other", exposed: false, label: "pass" }),
      row({ runId: "k", skill: "s", exposed: false, read: true, label: "fail" }),
    ];
    expect(buildCanaryWindow(rows, "s", 1000)).toEqual({
      exposedEligible: 4,
      exposed: { n: 3, pass: 1 },
      unexposed: { n: 2, pass: 1 },
      reads: 3,
    });
  });

  it("I4: a manufactured regression is rolled back to the previous version within one housekeeping pass, with trail, registry and lifecycle updated", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const name = "curl-timeout-guard";
    const now = Date.now();
    // v1: the human-authored version the gate replaced (archived with an
    // empty sidecar manifest, as publishStaged does).
    const v1 = `---\nname: ${name}\ndescription: Use when running curl against flaky hosts that time out\n---\nv1 body\n`;
    const archived = await archiveVersion(roots, {
      name,
      content: v1,
      reason: "pre-publish snapshot",
      author: "evolution",
      sidecars: {},
    });
    await writeEvolved(tmp, name, {
      ladder: { state: "canary", at: now - DAY, by: "gate" },
      canary: { startedAt: now - DAY, bucketFraction: 0.5, reason: "gate" },
      promotedFrom: archived.version,
      validation: { mode: "tasks", verdict: "accepted", validatedAt: now - DAY, model: "m/1" },
      published: { at: now - DAY, contentHash: "ab".repeat(32) },
    });
    await registerCanary(
      name,
      {
        startedAt: now - DAY,
        bucketFraction: 0.5,
        descriptionAtStart: "Use when running curl against flaky hosts that time out",
        reason: "gate",
      },
      { configDir: tmp },
    );
    // Production: 8 exposed runs read the skill and every one fails on the
    // agent's side; 8 withheld runs on the same kind of task pass.
    const journal = makeFixtureJournal();
    const live = liveSkillPath(roots, name);
    for (let i = 0; i < 8; i++) {
      appendFixtureRun(journal, {
        runId: `exposed-${i}`,
        task: { text: "run curl against the flaky host and fix the timeout" },
        exposure: { exposed: [name], withheld: [] },
        steps: [
          { kind: "tool", name: "read", args: { path: live }, result: "skill" },
          {
            kind: "tool",
            name: "edit",
            args: { path: "x" },
            isError: true,
            result: "Could not find the exact text; old_string not found",
          },
        ],
        terminal: "end",
        tsBase: now - 12 * 60 * 60 * 1000 + i * 1000,
      });
      appendFixtureRun(journal, {
        runId: `withheld-${i}`,
        task: { text: "run curl against the flaky host and fix the timeout" },
        exposure: { exposed: [], withheld: [name] },
        steps: [{ kind: "tool", name: "exec", args: { command: "curl --max-time 5 x" } }],
        completedExplicitly: true,
        tsBase: now - 12 * 60 * 60 * 1000 + i * 1000,
      });
    }
    const db = newDb();
    const published: string[] = [];
    const result = await runHousekeeping(
      {
        journal,
        llmCall: null,
        db,
        storeOpts: { configDir: tmp },
        propagate: true,
        publisher: {
          publishSkill: async (b64) => {
            published.push(Buffer.from(b64, "base64").toString("utf-8"));
          },
        },
        routingRepair: false,
        semanticLintCadenceDays: 0,
        cycleId: "iter-1",
      },
      { configDir: tmp },
    );
    // The ledger saw both cohorts.
    expect(result.skillReads?.credited).toBe(8);
    const rows = await readCanaryRuns({ configDir: tmp });
    expect(
      rows.filter((r) => r.exposed && r.read && r.eligible && r.label === "fail"),
    ).toHaveLength(8);
    expect(rows.filter((r) => !r.exposed && r.eligible && r.label === "pass")).toHaveLength(8);
    // The monitor rolled the skill back in the SAME pass.
    expect(result.monitor?.actions).toEqual([
      expect.objectContaining({ skillName: name, action: "rolled-back" }),
    ]);
    expect(await readLive(roots, name)).toBe(v1);
    // The evolved identity went with the regressed bytes (v1 had none).
    await expect(
      fs.access(path.join(path.dirname(live), ".evolution-meta.json")),
    ).rejects.toThrow();
    // Registry cleared; the regressed version archived as v2.
    expect((await readCanaryRegistry({ configDir: tmp })).skills).toEqual({});
    expect((await readArchivedVersion(roots, name, 2))?.content).toContain("v2 body");
    // Trail: rollback with the statistics, then the retraction.
    const trail = await readProvenance({ configDir: tmp });
    const rollback = trail.find((t) => t.action === "rollback");
    expect(rollback).toMatchObject({
      skillName: name,
      verdict: "rolled-back",
      iteration: "iter-1",
    });
    expect((rollback?.stats as Record<string, number> | undefined)?.pValue).toBeLessThan(0.0125);
    expect(trail.find((t) => t.action === "p2p-retract")).toMatchObject({ skillName: name });
    // The mesh got a signed retraction stub naming the published hash.
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("wiki-evolution-retraction");
    expect(published[0]).toContain("ab".repeat(32));
    expect(await fs.readFile(retractionsPath({ configDir: tmp }), "utf-8")).toContain(
      '"direction":"own"',
    );
    expect(new SkillLifecycleStore(db).get(name)?.state).toBe("active");
    // Evidence record was rebuilt after the transition.
    expect(result.evidenceRecords).toBe(1);
  });

  it("a regressed CREATE (no previous version) is retired: archived, removed, registry cleared", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const now = Date.now();
    await writeEvolved(tmp, "brand-new", {
      ladder: { state: "canary", at: now - DAY, by: "gate" },
      canary: { startedAt: now - DAY, bucketFraction: 0.5, reason: "gate" },
      promotedFrom: null,
    });
    await registerCanary(
      "brand-new",
      { startedAt: now - DAY, bucketFraction: 0.5, descriptionAtStart: "d", reason: "gate" },
      { configDir: tmp },
    );
    const rows: CanaryRunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(row({ runId: `e${i}`, skill: "brand-new", read: true, label: "fail" }));
      rows.push(row({ runId: `u${i}`, skill: "brand-new", exposed: false, label: "pass" }));
    }
    await appendCanaryRuns(rows, { configDir: tmp });
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "brand-new", success: true, timestamp: now });
    const r = await runCanaryMonitor({
      storeOpts: { configDir: tmp },
      lifecycleStore: store,
      now,
    });
    expect(r.actions).toEqual([expect.objectContaining({ action: "retired" })]);
    expect(await readLive(roots, "brand-new")).toBeNull();
    expect((await readArchivedVersion(roots, "brand-new", 1))?.content).toContain("v2 body");
    expect((await readCanaryRegistry({ configDir: tmp })).skills).toEqual({});
    expect(new SkillLifecycleStore(db).get("brand-new")?.state).toBe("archived");
    const trail = await readProvenance({ configDir: tmp });
    expect(trail.at(-1)).toMatchObject({ action: "retire", verdict: "rolled-back" });
  });

  it("retires a canary the router never opens (D-5) and graduates one that survives its window", async () => {
    const now = Date.now();
    await writeEvolved(tmp, "never-read", {
      ladder: { state: "canary", at: now - DAY, by: "gate" },
      canary: { startedAt: now - DAY, bucketFraction: 0.5, reason: "gate" },
      promotedFrom: null,
    });
    await writeEvolved(tmp, "survivor", {
      ladder: { state: "canary", at: now - 15 * DAY, by: "gate" },
      canary: { startedAt: now - 15 * DAY, bucketFraction: 0.5, reason: "gate" },
      promotedFrom: null,
      validation: { mode: "tasks", verdict: "accepted", validatedAt: now - 15 * DAY },
    });
    for (const name of ["never-read", "survivor"]) {
      await registerCanary(
        name,
        { startedAt: now - 15 * DAY, bucketFraction: 0.5, descriptionAtStart: "d", reason: "gate" },
        { configDir: tmp },
      );
    }
    const rows: CanaryRunRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(row({ runId: `nr${i}`, skill: "never-read", read: false }));
    }
    for (let i = 0; i < 8; i++) {
      rows.push(row({ runId: `s${i}`, skill: "survivor", read: i % 2 === 0, label: "pass" }));
      rows.push(row({ runId: `su${i}`, skill: "survivor", exposed: false, label: "pass" }));
    }
    await appendCanaryRuns(rows, { configDir: tmp });
    const r = await runCanaryMonitor({ storeOpts: { configDir: tmp }, now });
    expect(r.actions.map((a) => [a.skillName, a.action])).toEqual([
      ["never-read", "retired"],
      ["survivor", "graduated"],
    ]);
    const roots = resolveStorageRoots({ configDir: tmp });
    expect(await readLive(roots, "never-read")).toBeNull();
    const meta = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(liveSkillPath(roots, "survivor")), ".evolution-meta.json"),
        "utf-8",
      ),
    ) as EvolutionMeta;
    expect(meta.ladder).toMatchObject({ state: "stable", by: "monitor", previous: "canary" });
    expect(meta.canary?.endedAt).toBe(now);
    expect((await readCanaryRegistry({ configDir: tmp })).skills).toEqual({});
    // A second pass is a no-op.
    const again = await runCanaryMonitor({ storeOpts: { configDir: tmp }, now });
    expect(again.actions).toEqual([]);
    const records = await refreshEvidenceRecords({ storeOpts: { configDir: tmp } });
    expect(records.find((x) => x.name === "survivor")?.ladder).toBe("stable");
  });

  it("a PATCH canary the router never opens rolls back to the previous version instead of vanishing (adversarial 3-1)", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const now = Date.now();
    const v1 =
      "---\nname: patched\ndescription: Use when running curl against flaky hosts that time out\n---\nhuman v1\n";
    const archived = await archiveVersion(roots, {
      name: "patched",
      content: v1,
      reason: "pre-publish snapshot",
      author: "evolution",
      sidecars: {},
    });
    await writeEvolved(tmp, "patched", {
      ladder: { state: "canary", at: now - DAY, by: "gate" },
      canary: { startedAt: now - DAY, bucketFraction: 0.5, reason: "gate" },
      promotedFrom: archived.version,
    });
    await registerCanary(
      "patched",
      { startedAt: now - DAY, bucketFraction: 0.5, descriptionAtStart: "d", reason: "gate" },
      { configDir: tmp },
    );
    const rows: CanaryRunRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(row({ runId: `p${i}`, skill: "patched", read: false }));
    }
    await appendCanaryRuns(rows, { configDir: tmp });
    const r = await runCanaryMonitor({ storeOpts: { configDir: tmp }, now });
    expect(r.actions).toEqual([
      expect.objectContaining({ skillName: "patched", action: "rolled-back" }),
    ]);
    expect(await readLive(roots, "patched")).toBe(v1);
  });

  it("persists a consumed checkpoint so the next pass does not re-test the same size (adversarial 3-5)", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const now = Date.now();
    await writeEvolved(tmp, "looked", {
      ladder: { state: "canary", at: now - DAY, by: "gate" },
      canary: { startedAt: now - DAY, bucketFraction: 0.5, reason: "gate" },
    });
    await registerCanary(
      "looked",
      { startedAt: now - DAY, bucketFraction: 0.5, descriptionAtStart: "d", reason: "gate" },
      { configDir: tmp },
    );
    const rows: CanaryRunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(
        row({ runId: `e${i}`, skill: "looked", read: true, label: i < 3 ? "pass" : "fail" }),
      );
      rows.push(
        row({ runId: `u${i}`, skill: "looked", exposed: false, label: i < 7 ? "pass" : "fail" }),
      );
    }
    await appendCanaryRuns(rows, { configDir: tmp });
    const metaPath = path.join(
      path.dirname(liveSkillPath(roots, "looked")),
      ".evolution-meta.json",
    );
    const first = await runCanaryMonitor({ storeOpts: { configDir: tmp }, now });
    expect(first.actions[0]?.action).toBe("continue");
    expect(
      (JSON.parse(await fs.readFile(metaPath, "utf-8")) as EvolutionMeta).canary?.checkpoints,
    ).toEqual([8]);
    const second = await runCanaryMonitor({ storeOpts: { configDir: tmp }, now });
    expect(second.actions[0]?.action).toBe("continue");
    expect(
      (JSON.parse(await fs.readFile(metaPath, "utf-8")) as EvolutionMeta).canary?.checkpoints,
    ).toEqual([8]);
  });

  it("keeps watching while evidence is thin and removes a stale registry entry", async () => {
    const now = Date.now();
    await writeEvolved(tmp, "thin", {
      ladder: { state: "canary", at: now - DAY, by: "gate" },
      canary: { startedAt: now - DAY, bucketFraction: 0.5, reason: "gate" },
    });
    await registerCanary(
      "thin",
      { startedAt: now - DAY, bucketFraction: 0.5, descriptionAtStart: "d", reason: "gate" },
      { configDir: tmp },
    );
    await registerCanary(
      "ghost",
      { startedAt: now - DAY, bucketFraction: 0.5, descriptionAtStart: "d", reason: "gate" },
      { configDir: tmp },
    );
    await appendCanaryRuns(
      [
        row({ runId: "a", skill: "thin", read: true, label: "fail" }),
        row({ runId: "b", skill: "thin", exposed: false, label: "pass" }),
      ],
      { configDir: tmp },
    );
    const r = await runCanaryMonitor({ storeOpts: { configDir: tmp }, now });
    expect(r.actions.map((a) => [a.skillName, a.action])).toEqual([
      ["ghost", "stale"],
      ["thin", "continue"],
    ]);
    expect(Object.keys((await readCanaryRegistry({ configDir: tmp })).skills)).toEqual(["thin"]);
  });

  it("3.5: a stable skill validated on another primary model is re-canaried once per target model", async () => {
    const now = Date.now();
    await writeEvolved(tmp, "stable-one", {
      ladder: { state: "stable", at: now - 20 * DAY, by: "monitor" },
      validation: {
        mode: "tasks",
        verdict: "accepted",
        validatedAt: now - 30 * DAY,
        model: "openai/a",
      },
    });
    await writeEvolved(tmp, "same-model", {
      ladder: { state: "stable", at: now - 20 * DAY, by: "monitor" },
      validation: {
        mode: "tasks",
        verdict: "accepted",
        validatedAt: now - 30 * DAY,
        model: "openai/b",
      },
    });
    // Unknown current model: no-op.
    expect(
      (await runCanaryMonitor({ storeOpts: { configDir: tmp }, runtimeModelTag: null, now }))
        .actions,
    ).toEqual([]);
    const r = await runCanaryMonitor({
      storeOpts: { configDir: tmp },
      runtimeModelTag: "openai/b",
      now,
    });
    expect(r.actions).toEqual([
      expect.objectContaining({ skillName: "stable-one", action: "re-canaried" }),
    ]);
    const registry = await readCanaryRegistry({ configDir: tmp });
    expect(registry.skills["stable-one"]).toMatchObject({ reason: "model-drift" });
    expect(registry.skills["same-model"]).toBeUndefined();
    const roots = resolveStorageRoots({ configDir: tmp });
    const meta = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(liveSkillPath(roots, "stable-one")), ".evolution-meta.json"),
        "utf-8",
      ),
    ) as EvolutionMeta;
    expect(meta.ladder).toMatchObject({ state: "canary", by: "model-drift", previous: "stable" });
    expect(meta.modelDrift).toMatchObject({ from: "openai/a", to: "openai/b" });
    // Now a canary again: the drift check does not fire twice; after it
    // graduates, the same target model does not re-trigger.
    const again = await runCanaryMonitor({
      storeOpts: { configDir: tmp },
      runtimeModelTag: "openai/b",
      now,
    });
    expect(again.actions.map((a) => a.action)).toEqual(["continue"]);
    const trail = await readProvenance({ configDir: tmp });
    expect(trail.filter((t) => t.action === "re-canary")).toHaveLength(1);
  });

  it("3.6: a staged create held at the cap frees a slot by retiring the weakest evidence (zero reads first, then lowest score), honoring the grace period", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const now = Date.now();
    await writeEvolved(tmp, "unread-old", {
      ladder: { state: "stable", at: now - 10 * DAY, by: "monitor" },
      validation: { mode: "tasks", verdict: "accepted", validatedAt: now - 10 * DAY },
    });
    await writeEvolved(tmp, "weak", {
      ladder: { state: "stable", at: now - 10 * DAY, by: "monitor" },
      validation: { mode: "tasks", verdict: "accepted", validatedAt: now - 10 * DAY },
    });
    await writeEvolved(tmp, "strong", {
      ladder: { state: "stable", at: now - 10 * DAY, by: "monitor" },
      validation: { mode: "tasks", verdict: "accepted", validatedAt: now - 10 * DAY },
    });
    await writeEvolved(tmp, "too-young", {
      ladder: { state: "canary", at: now - DAY, by: "gate" },
      validation: { mode: "tasks", verdict: "accepted", validatedAt: now - DAY },
    });
    // Evidence: reads ledger drives the records.
    const reads = (skill: string, labels: string[]) =>
      labels.map((label, i) => ({
        runId: `${skill}-${i}`,
        skill,
        ts: now - i * 1000,
        success: label === "pass",
        label,
        outcomeLevel: 2,
        model: null,
        completedExplicitly: true,
        toolErrors: 0,
        origin: "human",
        sessionKey: null,
        credited: true,
      }));
    await fs.mkdir(path.join(tmp, "skill-wiki"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "skill-wiki", "skill-reads.jsonl"),
      `${[
        ...reads("weak", ["fail", "fail", "pass"]),
        ...reads("strong", ["pass", "pass", "pass", "pass"]),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const records = await refreshEvidenceRecords({ storeOpts: { configDir: tmp }, now });
    expect(evidenceScore(records.find((r) => r.name === "unread-old"))).toBe(0);
    expect(evidenceScore(records.find((r) => r.name === "weak"))).toBeLessThan(
      evidenceScore(records.find((r) => r.name === "strong")),
    );
    // No staged create: nothing happens even over the cap.
    expect(
      await retireEvolvedAtCap({ storeOpts: { configDir: tmp }, maxActiveEvolved: 2, now }),
    ).toEqual([]);
    // Two staged creates, cap 3 with 4 live: free 2 slots -> unread-old then weak.
    for (const name of ["new-a", "new-b"]) {
      await stageSkill(roots, {
        name,
        content: `---\nname: ${name}\ndescription: d\n---\nbody\n`,
        reason: "evolution",
        author: "evolution",
      });
      await fs.writeFile(
        path.join(roots.stagingRoot, name, ".evolution-meta.json"),
        JSON.stringify({ origin: "wiki-evolution", stagedAt: now }),
      );
    }
    // An untrusted-evidence-only create costs nothing (adversarial 3-6).
    await stageSkill(roots, {
      name: "poison",
      content: "---\nname: poison\ndescription: d\n---\nbody\n",
      reason: "evolution",
      author: "evolution",
    });
    await fs.writeFile(
      path.join(roots.stagingRoot, "poison", ".evolution-meta.json"),
      JSON.stringify({
        origin: "wiki-evolution",
        stagedAt: now,
        evidence: { runIds: ["x"], origins: ["circle"] },
      }),
    );
    const actions = await retireEvolvedAtCap({
      storeOpts: { configDir: tmp },
      maxActiveEvolved: 3,
      now,
    });
    expect(actions.map((a) => [a.skillName, a.action])).toEqual([
      ["unread-old", "retired"],
      ["weak", "retired"],
    ]);
    expect(await readLive(roots, "strong")).not.toBeNull();
    expect(await readLive(roots, "too-young")).not.toBeNull();
    expect(await readLive(roots, "weak")).toBeNull();
    const trail = await readProvenance({ configDir: tmp });
    expect(trail.filter((t) => t.action === "retire").map((t) => t.detail)).toEqual([
      expect.stringContaining("cap"),
      expect.stringContaining("cap"),
    ]);
  });
});
