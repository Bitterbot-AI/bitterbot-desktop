/**
 * PLAN-44 Phase 5a: the usage signal. A live skill the agent opened in a
 * real run is credited from the journal, once, with the run's outcome.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveSkillPath, resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { SkillLifecycleStore } from "../skill-lifecycle.js";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { creditSkillReads, skillReadsPath, summarizeSkillReads } from "./skill-reads.js";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db, embeddingCacheTable: "embedding_cache", ftsTable: "chunks_fts" });
  runMigrations(db);
  return db;
}

describe("creditSkillReads", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-reads-"));
    const roots = resolveStorageRoots({ configDir: tmp });
    for (const name of ["curl-timeout-guard", "git-not-a-repo"]) {
      await fs.mkdir(path.dirname(liveSkillPath(roots, name)), { recursive: true });
      await fs.writeFile(
        liveSkillPath(roots, name),
        `---\nname: ${name}\ndescription: d\n---\nbody\n`,
      );
    }
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("credits one event per (run, skill) with the run outcome, updates the lifecycle store, and is idempotent", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const journal = makeFixtureJournal();
    const curl = liveSkillPath(roots, "curl-timeout-guard");
    appendFixtureRun(journal, {
      runId: "run-ok",
      steps: [
        { kind: "tool", name: "read", args: { path: curl }, result: "skill body" },
        { kind: "tool", name: "read", args: { path: curl }, result: "skill body" },
        { kind: "tool", name: "exec", args: { command: "curl --max-time 30 x" }, result: "ok" },
      ],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "run-failed",
      steps: [
        {
          kind: "tool",
          name: "exec",
          args: { command: `cat ${liveSkillPath(roots, "git-not-a-repo")}` },
          result: "...",
        },
      ],
      terminal: "error",
      errorText: "boom",
    });
    appendFixtureRun(journal, {
      runId: "run-noskill",
      steps: [{ kind: "tool", name: "read", args: { path: "/tmp/other.md" }, result: "x" }],
    });
    const db = newDb();
    const first = await creditSkillReads({ journal, db, storeOpts: { configDir: tmp } });
    expect(first.credited).toBe(2);
    expect(first.events.map((e) => [e.runId, e.skill, e.success])).toEqual([
      ["run-ok", "curl-timeout-guard", true],
      ["run-failed", "git-not-a-repo", false],
    ]);
    const store = new SkillLifecycleStore(db);
    expect(store.get("curl-timeout-guard")).toMatchObject({ usageCount: 1, successCount: 1 });
    expect(store.get("git-not-a-repo")).toMatchObject({ usageCount: 1, successCount: 0 });
    const ledger = await fs.readFile(skillReadsPath({ configDir: tmp }), "utf-8");
    expect(ledger.trim().split("\n")).toHaveLength(2);
    // Second pass: nothing new, counters untouched.
    const second = await creditSkillReads({ journal, db, storeOpts: { configDir: tmp } });
    expect(second.credited).toBe(0);
    expect(store.get("curl-timeout-guard")?.usageCount).toBe(1);
  });

  it("defers an incomplete run and credits it once it ends; never credits validation sessions", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const journal = makeFixtureJournal();
    const curl = liveSkillPath(roots, "curl-timeout-guard");
    appendFixtureRun(journal, {
      runId: "run-open",
      steps: [{ kind: "tool", name: "read", args: { path: curl }, result: "body" }],
      terminal: "none",
    });
    appendFixtureRun(journal, {
      runId: "run-val",
      sessionKey: "agent:main:skill-evolve-val-abc",
      steps: [{ kind: "tool", name: "read", args: { path: curl }, result: "body" }],
    });
    const db = newDb();
    const first = await creditSkillReads({ journal, db, storeOpts: { configDir: tmp } });
    expect(first.credited).toBe(0);
    // The run ends later (a new lifecycle row for the same runId).
    appendFixtureRun(journal, { runId: "run-open", steps: [], completedExplicitly: true });
    const second = await creditSkillReads({ journal, db, storeOpts: { configDir: tmp } });
    expect(second.events.map((e) => e.runId)).toEqual(["run-open"]);
    expect(new SkillLifecycleStore(db).get("curl-timeout-guard")?.usageCount).toBe(1);
  });

  it("summarizeSkillReads folds the ledger into windowed per-skill rates, listing zero-read live skills too", async () => {
    const now = Date.now();
    await fs.mkdir(path.dirname(skillReadsPath({ configDir: tmp })), { recursive: true });
    await fs.writeFile(
      skillReadsPath({ configDir: tmp }),
      [
        { runId: "a", skill: "curl-timeout-guard", ts: now - 1000, success: true },
        { runId: "b", skill: "curl-timeout-guard", ts: now - 2000, success: false },
        { runId: "old", skill: "curl-timeout-guard", ts: now - 20 * 86_400_000, success: true },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const summary = await summarizeSkillReads({
      storeOpts: { configDir: tmp },
      liveNames: ["curl-timeout-guard", "git-not-a-repo"],
      now,
    });
    expect(summary).toEqual([
      {
        name: "curl-timeout-guard",
        reads: 2,
        successes: 1,
        successRate: 0.5,
        lastReadAt: now - 1000,
        runs: 2,
      },
      {
        name: "git-not-a-repo",
        reads: 0,
        successes: 0,
        successRate: null,
        lastReadAt: null,
        runs: 0,
      },
    ]);
  });
});

describe("creditSkillReads hardening (adversarial pass)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-reads-adv-"));
    const roots = resolveStorageRoots({ configDir: tmp });
    await fs.mkdir(path.dirname(liveSkillPath(roots, "curl-timeout-guard")), { recursive: true });
    await fs.writeFile(
      liveSkillPath(roots, "curl-timeout-guard"),
      "---\nname: curl-timeout-guard\ndescription: d\n---\nbody\n",
    );
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const readStep = (p: string) => ({
    kind: "tool" as const,
    name: "read",
    args: { path: p },
    result: "body",
  });

  it("H1: runs deferred by the per-pass cap are credited on the next pass, never skipped", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const curl = liveSkillPath(roots, "curl-timeout-guard");
    const journal = makeFixtureJournal();
    for (const id of ["r1", "r2", "r3", "r4"]) {
      appendFixtureRun(journal, { runId: id, steps: [readStep(curl)], completedExplicitly: true });
    }
    const seen: string[] = [];
    for (let pass = 0; pass < 6 && seen.length < 4; pass++) {
      const r = await creditSkillReads({
        journal,
        storeOpts: { configDir: tmp },
        maxRunsPerPass: 1,
      });
      seen.push(...r.events.map((e) => e.runId));
    }
    expect(seen.toSorted()).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("M2: a pending run with start,start (retry, no terminal) stays pending; it is credited once it ends", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const curl = liveSkillPath(roots, "curl-timeout-guard");
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, { runId: "retry", steps: [readStep(curl)], terminal: "none" });
    appendFixtureRun(journal, { runId: "retry", steps: [], terminal: "none" }); // a second start
    const first = await creditSkillReads({ journal, storeOpts: { configDir: tmp } });
    expect(first.credited).toBe(0);
    const state = JSON.parse(
      await fs.readFile(path.join(tmp, "skill-wiki", "skill-reads-state.json"), "utf-8"),
    ) as {
      pending: Array<{ runId: string }>;
    };
    expect(state.pending.map((p) => p.runId)).toEqual(["retry"]);
    appendFixtureRun(journal, { runId: "retry", steps: [], completedExplicitly: true });
    const second = await creditSkillReads({ journal, storeOpts: { configDir: tmp } });
    expect(second.events.map((e) => [e.runId, e.success])).toEqual([["retry", true]]);
  });

  it("M3: third-party and heartbeat runs are logged but never credited to the lifecycle counters or the default summary", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const curl = liveSkillPath(roots, "curl-timeout-guard");
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "circle",
      sessionKey: "agent:main:circle:c1",
      steps: [readStep(curl)],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "a2a",
      sessionKey: "agent:main:a2a-task:x",
      steps: [readStep(curl)],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "human",
      sessionKey: "agent:main:main",
      steps: [readStep(curl)],
      completedExplicitly: true,
    });
    const db = newDb();
    const r = await creditSkillReads({ journal, db, storeOpts: { configDir: tmp } });
    expect(r.events.map((e) => [e.runId, e.credited])).toEqual([
      ["circle", false],
      ["a2a", false],
      ["human", true],
    ]);
    expect(new SkillLifecycleStore(db).get("curl-timeout-guard")?.usageCount).toBe(1);
    const summary = await summarizeSkillReads({
      storeOpts: { configDir: tmp },
      liveNames: ["curl-timeout-guard"],
    });
    expect(summary[0]?.reads).toBe(1);
    const all = await summarizeSkillReads({
      storeOpts: { configDir: tmp },
      liveNames: ["curl-timeout-guard"],
      includeThirdParty: true,
    });
    expect(all[0]?.reads).toBe(3);
  });

  it("L6: resolves ~ and workspace-relative read paths; a sandbox copy is not credited", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const curl = liveSkillPath(roots, "curl-timeout-guard");
    const journal = makeFixtureJournal();
    const home = process.env.HOME ?? "";
    const tilde = curl.startsWith(home) ? `~${curl.slice(home.length)}` : curl;
    appendFixtureRun(journal, {
      runId: "tilde",
      steps: [readStep(tilde)],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "rel",
      steps: [readStep(path.relative(tmp, curl))],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "sandbox",
      steps: [readStep("/sandbox/skills/curl-timeout-guard/SKILL.md")],
      completedExplicitly: true,
    });
    const r = await creditSkillReads({ journal, storeOpts: { configDir: tmp }, workspaceDir: tmp });
    expect(r.events.map((e) => e.runId).toSorted()).toEqual(["rel", "tilde"]);
  });
});
