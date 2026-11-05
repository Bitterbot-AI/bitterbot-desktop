import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCanaryRegistry } from "../agents/skills/canary-registry.js";
import { readLive, resolveStorageRoots } from "../agents/skills/skill-storage.js";
import { FailureExperiments } from "./failure-experiments.js";
import type { LearningConfigInput } from "./procedural-learning-contract.js";
import { ProceduralLearningStore } from "./procedural-learning-store.js";
import {
  appendFixtureRun,
  makeFixtureJournal,
} from "./skill-evolution/__fixtures__/journal-fixture.js";
import type { EvolutionPassDeps } from "./skill-evolution/evolution-pass.js";
import { isRunHeldOut, readSamplerCursor } from "./skill-evolution/sampler.js";
import { corpusPath } from "./skill-evolution/task-corpus.js";

const HOUR = 3_600_000;
const SKILL =
  "---\nname: parser-repair\ndescription: Repair the result when a synthetic parser task reports a missing input; not for arithmetic or unrelated file tasks.\n---\n\n## When to Apply\nSynthetic parser tasks.\n\n## When NOT to Apply\nOther tasks.\n\nReturn the corrected parse result.";
const MAINTENANCE = JSON.stringify({
  create_patterns: [
    { name: "parser-error", content: "# Parser error\nGuard the missing input before parsing." },
  ],
  update_patterns: [],
  update_index: "- [parser-error](patterns/parser-error.md): Guard missing inputs.",
  append_log: "Parser failure observed.",
});
const NO_ACTION = JSON.stringify({
  tool: "finish",
  proposal: { action: "no_action", reason: "Insufficient support" },
});

describe("automatic failure experiments (real sampler, proposer, staging and task gate)", () => {
  let root: string;
  let db: DatabaseSync;
  let now: number;
  let journal: ReturnType<typeof makeFixtureJournal>;
  let store: ProceduralLearningStore;
  let runner: FailureExperiments;
  let deps: EvolutionPassDeps;
  let allowed: boolean;
  let failureId: string;
  const options = () => ({ cadenceMs: HOUR, canDispatch: () => allowed });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "failure-learning-"));
    db = new DatabaseSync(path.join(root, "learning.sqlite"));
    now = Date.now();
    allowed = true;
    journal = makeFixtureJournal();
    failureId = Array.from({ length: 100 }, (_, i) => `failure-${i}`).find(
      (id) => !isRunHeldOut(id),
    )!;
    appendFixtureRun(journal, {
      runId: failureId,
      task: { text: "Repair the parser" },
      steps: [
        {
          kind: "tool",
          name: "exec",
          result: "TypeError: Cannot read properties of undefined (private-input-marker)",
          isError: true,
        },
      ],
    });
    store = new ProceduralLearningStore(db, {}, () => now);
    runner = new FailureExperiments(store);
    deps = {
      journal,
      llmCall: async (prompt) =>
        prompt.includes("Skill Proposer Agent") ? NO_ACTION : MAINTENANCE,
      storeOpts: { configDir: root },
      semanticLintCadenceDays: 0,
      routingRepair: false,
      descriptionRepair: false,
      propagate: false,
      trialsPerTask: 1,
      validationMode: "tasks",
      modelTag: "synthetic/offline",
    };
  });
  afterEach(async () => {
    await runner.close();
    journal.close();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  function configure(config: LearningConfigInput) {
    store = new ProceduralLearningStore(db, config, () => now);
    runner = new FailureExperiments(store);
  }
  function row() {
    return db.prepare("SELECT * FROM failure_experiments").get();
  }
  async function prepareCandidate(behavior: "improve" | "regress" | "unread" = "improve") {
    await fs.mkdir(path.dirname(corpusPath({ configDir: root })), { recursive: true });
    await fs.writeFile(
      corpusPath({ configDir: root }),
      Array.from({ length: 6 }, (_, i) =>
        JSON.stringify({
          id: `parser-${i}`,
          prompt: `Synthetic parser task ${i}. Reply FINAL: <result>.`,
          checker: { kind: "final", value: "PASS" },
          suite: "capability",
        }),
      ).join("\n") + "\n",
    );
    let proposerCalls = 0;
    deps.proposerLlmCall = async () =>
      ++proposerCalls === 1
        ? JSON.stringify({ tool: "read_file", path: `traces/${failureId}` })
        : JSON.stringify({
            tool: "finish",
            proposal: {
              action: "create",
              name: "parser-repair",
              skill_md: SKILL,
              purpose_md:
                "# Purpose\n\n## Origin\nwiki-evolution\n\n## Patterns Addressed\n- Parser error\n",
            },
          });
    // Scripted executor, not a sampled model. It goes through the production
    // scratch-workspace runner and records observable tool reads in the journal.
    let turns = 0;
    deps.agentTurn = async (prompt, opts) => {
      const location = path.join(opts!.workspaceDir!, "skills", "parser-repair", "SKILL.md");
      const content = await fs.readFile(location, "utf8").catch(() => null);
      const relevant = prompt.startsWith("Synthetic parser task");
      const read = relevant && content !== null && behavior !== "unread";
      const runId = `trial-${++turns}`;
      appendFixtureRun(journal, {
        runId,
        sessionKey: "agent:main:skill-evolve:task-test",
        steps: read
          ? [{ kind: "tool", name: "read", args: { path: location }, result: content }]
          : [],
      });
      const pass = relevant && (behavior === "regress" ? !content : !!content);
      return {
        text: pass ? "FINAL: PASS" : "FINAL: wrong",
        runId,
        usage: { input: 10, output: 10 },
      };
    };
  }

  it.each(["improve", "regress", "unread"] as const)(
    "settles %s through the actual gate, with hash-bound receipts",
    async (behavior) => {
      await prepareCandidate(behavior);
      const result = await runner.run(deps, options());
      const expected =
        behavior === "improve" ? "promoted" : behavior === "regress" ? "rejected" : "held";
      expect(result?.proposalOutcome?.outcome).toBe("staged");
      expect(result?.validation).toEqual([
        expect.objectContaining({ skillName: "parser-repair", outcome: expected }),
      ]);
      expect(row()).toMatchObject({
        state: expected,
        candidate_hash: result?.proposalOutcome?.contentHash,
      });
      expect(db.prepare("SELECT * FROM failure_experiment_verdicts").all()).toHaveLength(1);
      const live = await readLive(resolveStorageRoots({ configDir: root }), "parser-repair");
      expect(live !== null).toBe(behavior === "improve");
      if (behavior === "improve") {
        expect(
          (await readCanaryRegistry({ configDir: root })).skills["parser-repair"],
        ).toBeDefined();
      }
      expect(JSON.stringify(runner.status())).not.toContain("private-input-marker");
      expect(await runner.run(deps, options())).toBeNull();
    },
  );

  it("treats a mid-experiment pause as HOLD, never as a measured failure or promotion", async () => {
    await prepareCandidate();
    const turn = deps.agentTurn!;
    deps.agentTurn = async (...args) => {
      const result = await turn(...args);
      allowed = false;
      return result;
    };
    const result = await runner.run(deps, options());
    expect(result?.validation).toEqual([
      expect.objectContaining({ outcome: "held", detail: expect.stringContaining("paused") }),
    ]);
    expect(row()).toMatchObject({ state: "held" });
    expect(
      db.prepare("SELECT status,agent_turns FROM failure_learning_cycles").get(),
    ).toMatchObject({ status: "held", agent_turns: 1 });
    expect(await readLive(resolveStorageRoots({ configDir: root }), "parser-repair")).toBeNull();
  });

  it("reserves dispatch limits before work and retries an interrupted proposal at most three times", async () => {
    configure({ automation: { maxLlmCalls: 1 } });
    const llm = vi.fn(deps.llmCall!);
    deps.llmCall = llm;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await runner.run(deps, options());
      expect(row()).toMatchObject({ state: "held", attempts: attempt });
      expect(await readSamplerCursor({ configDir: root })).toBe(0);
      now += HOUR;
    }
    await runner.run(deps, options());
    expect(row()).toMatchObject({ attempts: 3 });
    expect(await readSamplerCursor({ configDir: root })).toBeGreaterThan(0);
    expect(llm).toHaveBeenCalledTimes(4);
    expect(db.prepare("SELECT llm_calls FROM failure_learning_cycles").all()).toEqual(
      Array.from({ length: 4 }, () => ({ llm_calls: 1 })),
    );
  });

  it("does not consume a failure on an unparseable maintenance response", async () => {
    deps.llmCall = async () => "malformed";
    await runner.run(deps, options());
    expect(row()).toBeUndefined();
    now += HOUR;
    deps.llmCall = async (prompt) =>
      prompt.includes("Skill Proposer Agent") ? NO_ACTION : MAINTENANCE;
    await runner.run(deps, options());
    expect(row()).toMatchObject({ state: "no-action", attempts: 1 });
  });

  it("joins concurrent ticks, drains shutdown, and persists cadence across reopening", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.llmCall = async () => {
      await blocked;
      return MAINTENANCE;
    };
    const first = runner.run(deps, options());
    expect(runner.run(deps, options())).toBe(first);
    // Another host on the same durable store cannot steal a live process's run.
    expect(await new FailureExperiments(store).run(deps, options())).toBeNull();
    let closed = false;
    const close = runner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await first;
    await close;
    db.close();
    db = new DatabaseSync(path.join(root, "learning.sqlite"));
    store = new ProceduralLearningStore(db, {}, () => now);
    runner = new FailureExperiments(store);
    expect(await runner.run(deps, options())).toBeNull();
    expect(db.prepare("SELECT * FROM failure_learning_cycles").all()).toHaveLength(1);
  });

  it("holds at the wall limit without issuing another request", async () => {
    configure({ automation: { maxWallMinutes: 1 } });
    deps.llmCall = vi.fn(async () => {
      now += 60_000;
      return MAINTENANCE;
    });
    await runner.run(deps, options());
    expect(deps.llmCall).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status,summary FROM failure_learning_cycles").get()).toMatchObject({
      status: "held",
      summary: expect.stringContaining("wall-budget"),
    });
  });

  it("does not train on validation, peer, held-out or incomplete runs", async () => {
    journal.close();
    journal = makeFixtureJournal();
    deps.journal = journal;
    const heldOut = Array.from({ length: 100 }, (_, i) => `held-${i}`).find(isRunHeldOut)!;
    for (const run of [
      { runId: failureId, sessionKey: "agent:main:skill-evolve:task-test" },
      { runId: failureId + "-peer", sessionKey: "agent:main:a2a:remote" },
      { runId: heldOut },
      { runId: failureId + "-pending", terminal: "none" as const },
    ]) {
      appendFixtureRun(journal, {
        ...run,
        steps: [{ kind: "tool", name: "exec", result: "TypeError: missing input", isError: true }],
      });
    }
    await runner.run(deps, options());
    expect(row()).toBeUndefined();
  });

  it("recovers a dead owner's unfinished cycle without forgiving its reservations", async () => {
    await runner.run(deps, options());
    db.prepare("UPDATE failure_learning_cycles SET status='running',pid=2147483647").run();
    now += HOUR;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    try {
      await runner.run(deps, options());
    } finally {
      kill.mockRestore();
    }
    const cycles = db
      .prepare("SELECT status,llm_calls FROM failure_learning_cycles ORDER BY started_at")
      .all();
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ status: "interrupted", llm_calls: expect.any(Number) });
    expect(Number(cycles[0]?.llm_calls)).toBeGreaterThan(0);
  });

  it("enforces agent-turn limits as a hold", async () => {
    configure({ automation: { maxAgentTurns: 1 } });
    await prepareCandidate();
    const result = await runner.run(deps, options());
    expect(result?.validation?.[0]).toMatchObject({
      outcome: "held",
      detail: expect.stringContaining("agent_turns-budget"),
    });
    expect(db.prepare("SELECT agent_turns FROM failure_learning_cycles").get()).toMatchObject({
      agent_turns: 1,
    });
  });

  it("keeps a usage-budget exception out of measured trial outcomes", async () => {
    await prepareCandidate();
    deps.agentTurn = vi.fn(async () => {
      throw Object.assign(new Error("paused"), { name: "UsageBudgetPausedError" });
    });
    const result = await runner.run(deps, options());
    expect(result?.validation?.[0]).toMatchObject({
      outcome: "held",
      detail: expect.stringContaining("usage-budget"),
    });
    expect(deps.agentTurn).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status FROM failure_learning_cycles").get()).toMatchObject({
      status: "held",
    });
  });

  it.each([{ mode: "off" }, { mode: "active" }, { automation: { enabled: false } }] as const)(
    "does no work for %j",
    async (config) => {
      configure(config);
      deps.llmCall = vi.fn();
      expect(await runner.run(deps, options())).toBeNull();
      expect(deps.llmCall).not.toHaveBeenCalled();
      expect(runner.status().cycles).toEqual([]);
    },
  );
  it("does no work without a journal, model, or idle host", async () => {
    expect(await runner.run({ ...deps, journal: null }, options())).toBeNull();
    expect(await runner.run({ ...deps, llmCall: null }, options())).toBeNull();
    allowed = false;
    expect(await runner.run(deps, options())).toBeNull();
    expect(runner.status().cycles).toEqual([]);
  });
});
