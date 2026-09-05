import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenance } from "../../agents/skills/impact-trail.js";
import { readLive, resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { bootstrapMeanCi } from "./bootstrap-ci.js";
import { applyProposal } from "./proposal-apply.js";
import { isRunHeldOut } from "./sampler.js";
import { corpusPath, loadTaskCorpus, scoreTaskAnswer } from "./task-corpus.js";
import { TrialCache } from "./trial-cache.js";
import { validateAgainstTasks } from "./validate-tasks.js";
import { runValidationGate } from "./validation-gate.js";

const SKILL_MD =
  "---\nname: curl-timeout-guard\ndescription: Bound every curl in exec with --max-time when the task runs curl; not for commands that make no network calls.\n---\n\n## When to Apply\nAny exec call invoking curl.\n\n## When NOT to Apply\nNon-network commands.\n\nAlways pass --max-time 30.";
const PURPOSE_MD =
  "# Purpose\n\n## Origin\nwiki-evolution\n\n## Patterns Addressed\n- exec-network-timeout\n";

/** Journal with enough HELD-OUT complete tool-bearing runs for validation. */
function heldOutJournal(count = 8) {
  const journal = makeFixtureJournal();
  let found = 0;
  for (let i = 0; found < count && i < 10_000; i++) {
    const id = `ho-${i}`;
    if (!isRunHeldOut(id)) {
      continue;
    }
    found += 1;
    appendFixtureRun(journal, {
      runId: id,
      steps: [
        {
          kind: "tool",
          name: "exec",
          args: { cmd: "curl x" },
          result: "timeout",
          isError: i % 2 === 0,
        },
      ],
      terminal: i % 2 === 0 ? "error" : "end",
    });
  }
  return journal;
}

function scoresAccepting(n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ trial: i + 1, a: 0.3, b: 0.8 })));
}

function scoresRejecting(n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ trial: i + 1, a: 0.6, b: 0.6 })));
}

/**
 * PLAN-44 Phase 2: records mode scores BOTH presentation orders. A stub
 * that always scores "b" higher would cancel itself out; this wrapper
 * swaps a/b when the prompt presents the candidate as VERSION A.
 */
function orderAware(make: () => string) {
  return async (prompt: string): Promise<string> => {
    const raw = make();
    if (!prompt.includes("VERSION A — Candidate")) {
      return raw;
    }
    const parsed = JSON.parse(raw) as Array<{ trial: number; a: number; b: number }>;
    return JSON.stringify(parsed.map((e) => ({ trial: e.trial, a: e.b, b: e.a })));
  };
}

describe("bootstrapMeanCi", () => {
  it("is deterministic and directionally correct", () => {
    const up = bootstrapMeanCi([0.5, 0.4, 0.5, 0.6, 0.5, 0.4]);
    const up2 = bootstrapMeanCi([0.5, 0.4, 0.5, 0.6, 0.5, 0.4]);
    expect(up).toEqual(up2);
    expect(up.ci95Low).toBeGreaterThan(0);
    const flat = bootstrapMeanCi([0.1, -0.1, 0.05, -0.05, 0, 0]);
    expect(flat.ci95Low).toBeLessThanOrEqual(0);
  });
});

describe("runValidationGate (records mode)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "valgate-"));
    await applyProposal(
      { action: "create", name: "curl-timeout-guard", skillMd: SKILL_MD, purposeMd: PURPOSE_MD },
      { storeOpts: { configDir: tmpDir }, iteration: "it-1" },
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("promotes on measured improvement, carrying PURPOSE.md and validation metadata to live", async () => {
    const journal = heldOutJournal();
    const outcomes = await runValidationGate({
      journal,
      mode: "records",
      llmCall: orderAware(() => scoresAccepting(8)),
      storeOpts: { configDir: tmpDir },
      modelTag: "test/model-1",
      iteration: "it-1",
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ skillName: "curl-timeout-guard", outcome: "promoted" }),
    ]);
    const roots = resolveStorageRoots({ configDir: tmpDir });
    expect(await readLive(roots, "curl-timeout-guard")).toContain("--max-time");
    const liveDir = path.join(roots.liveRoot, "curl-timeout-guard");
    const meta = JSON.parse(
      await fs.readFile(path.join(liveDir, ".evolution-meta.json"), "utf-8"),
    ) as { origin: string; validation: { mode: string; verdict: string; model: string } };
    expect(meta.origin).toBe("wiki-evolution");
    expect(meta.validation).toMatchObject({
      mode: "records",
      verdict: "accepted",
      model: "test/model-1",
    });
    const purpose = await fs.readFile(path.join(liveDir, "PURPOSE.md"), "utf-8");
    expect(purpose).toContain("## Validation");
    expect(purpose).toContain("model=test/model-1");
    // Staging is settled.
    await expect(fs.access(path.join(roots.stagingRoot, "curl-timeout-guard"))).rejects.toThrow();
    const trail = await readProvenance({ configDir: tmpDir });
    expect(trail.at(-1)).toMatchObject({ verdict: "accepted", source: "evolution" });
  });

  it("rejects on no measured improvement: candidate discarded, live untouched, verdict recorded", async () => {
    const journal = heldOutJournal();
    const outcomes = await runValidationGate({
      journal,
      mode: "records",
      llmCall: orderAware(() => scoresRejecting(8)),
      storeOpts: { configDir: tmpDir },
    });
    expect(outcomes[0]).toMatchObject({ outcome: "rejected" });
    const roots = resolveStorageRoots({ configDir: tmpDir });
    expect(await readLive(roots, "curl-timeout-guard")).toBeNull();
    await expect(fs.access(path.join(roots.stagingRoot, "curl-timeout-guard"))).rejects.toThrow();
    const trail = await readProvenance({ configDir: tmpDir });
    expect(trail.at(-1)).toMatchObject({ verdict: "rejected" });
    expect(typeof trail.at(-1)?.contentHash).toBe("string");
  });

  it("HOLDS (not rejects) on insufficient held-out data or scoring failure", async () => {
    const emptyJournal = makeFixtureJournal();
    const held = await runValidationGate({
      journal: emptyJournal,
      llmCall: orderAware(() => scoresAccepting(8)),
      storeOpts: { configDir: tmpDir },
    });
    expect(held[0]).toMatchObject({ outcome: "held" });
    const roots = resolveStorageRoots({ configDir: tmpDir });
    // Still staged, retryable next iteration.
    await expect(
      fs.access(path.join(roots.stagingRoot, "curl-timeout-guard")),
    ).resolves.toBeUndefined();
    const parseFail = await runValidationGate({
      journal: heldOutJournal(),
      llmCall: async () => "I cannot score these",
      storeOpts: { configDir: tmpDir },
    });
    expect(parseFail[0]).toMatchObject({ outcome: "held" });
  });

  it("rejection dedup: identical content cannot be re-staged afterwards", async () => {
    await runValidationGate({
      journal: heldOutJournal(),
      llmCall: orderAware(() => scoresRejecting(8)),
      storeOpts: { configDir: tmpDir },
    });
    const again = await applyProposal(
      { action: "create", name: "curl-timeout-guard", skillMd: SKILL_MD, purposeMd: PURPOSE_MD },
      { storeOpts: { configDir: tmpDir }, iteration: "it-2" },
    );
    expect(again.outcome).toBe("duplicate-of-rejected");
    const roots = resolveStorageRoots({ configDir: tmpDir });
    await expect(fs.access(path.join(roots.stagingRoot, "curl-timeout-guard"))).rejects.toThrow();
  });

  it("holds net-new creates at the maxActiveEvolved cap", async () => {
    const outcomes = await runValidationGate({
      journal: heldOutJournal(),
      llmCall: orderAware(() => scoresAccepting(8)),
      storeOpts: { configDir: tmpDir },
      maxActiveEvolved: 0,
    });
    expect(outcomes[0]).toMatchObject({ outcome: "held" });
    const roots = resolveStorageRoots({ configDir: tmpDir });
    expect(await readLive(roots, "curl-timeout-guard")).toBeNull();
  });
  it("HOLDs an accepted records verdict when records mode was an automatic fallback (P0-4: model-predicted evidence never promotes)", async () => {
    const journal = heldOutJournal();
    const outcomes = await runValidationGate({
      journal,
      llmCall: orderAware(() => scoresAccepting(8)),
      storeOpts: { configDir: tmpDir },
      modelTag: "test/model-1",
      iteration: "it-1",
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ skillName: "curl-timeout-guard", outcome: "held" }),
    ]);
    expect(outcomes[0]?.detail).toContain("records-only-evidence");
    const roots = resolveStorageRoots({ configDir: tmpDir });
    // Staged, not live: the proposal waits for a grounded rollout.
    await expect(
      fs.access(path.join(roots.stagingRoot, "curl-timeout-guard")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(roots.liveRoot, "curl-timeout-guard"))).rejects.toThrow();
    const meta = JSON.parse(
      await fs.readFile(
        path.join(roots.stagingRoot, "curl-timeout-guard", ".evolution-meta.json"),
        "utf-8",
      ),
    ) as { lastValidation?: { verdict: string } };
    expect(meta.lastValidation).toMatchObject({ verdict: "records-only-evidence" });
  });
});

describe("task corpus + tasks validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads the shipped canonical exemplar and scores hardened checkers deterministically", async () => {
    const exemplar = await fs.readFile(
      path.join(process.cwd(), "benchmarks/skill-evolution/canonical-corpus.jsonl"),
      "utf-8",
    );
    await fs.mkdir(path.dirname(corpusPath({ configDir: tmpDir })), { recursive: true });
    await fs.writeFile(corpusPath({ configDir: tmpDir }), exemplar, "utf-8");
    const corpus = await loadTaskCorpus({ configDir: tmpDir });
    expect(corpus).not.toBeNull();
    expect(corpus?.tasks.length).toBe(15);
    expect(corpus?.version).toHaveLength(12);
    const arith = corpus?.tasks.find((t) => t.id === "arith-basic")!;
    const answer = arith.checker.value;
    expect(scoreTaskAnswer(arith, `Working it out...\nFINAL: ${answer}`)).toBe(1);
    // The hardened checker refuses a bare value or a wrong FINAL line.
    expect(scoreTaskAnswer(arith, `The answer is ${answer}.`)).toBe(0);
    expect(scoreTaskAnswer(arith, `FINAL: ${Number(answer) + 1}`)).toBe(0);
  });

  it("skips malformed lines and rejects invalid regex checkers", async () => {
    await fs.mkdir(path.dirname(corpusPath({ configDir: tmpDir })), { recursive: true });
    await fs.writeFile(
      corpusPath({ configDir: tmpDir }),
      [
        '{"id": "ok", "prompt": "p", "checker": {"kind": "contains", "value": "x"}}',
        "not json at all",
        '{"id": "bad-re", "prompt": "p", "checker": {"kind": "regex", "value": "([unclosed"}}',
        '{"id": "ok", "prompt": "dupe id", "checker": {"kind": "exact", "value": "x"}}',
      ].join("\n"),
      "utf-8",
    );
    const corpus = await loadTaskCorpus({ configDir: tmpDir });
    expect(corpus?.tasks.map((t) => t.id)).toEqual(["ok"]);
  });

  it("accepts only when the candidate arm measurably beats the incumbent arm", async () => {
    await fs.mkdir(path.dirname(corpusPath({ configDir: tmpDir })), { recursive: true });
    const lines = Array.from(
      { length: 8 },
      (_, i) =>
        `{"id": "t${i}", "prompt": "task ${i}", "checker": {"kind": "contains", "value": "PASS"}}`,
    );
    await fs.writeFile(corpusPath({ configDir: tmpDir }), lines.join("\n"), "utf-8");
    const corpus = (await loadTaskCorpus({ configDir: tmpDir }))!;
    const better = await validateAgainstTasks({
      corpus,
      runTask: async (_task, variant) => (variant === "candidate" ? "PASS" : "FAIL"),
    });
    expect(better.accepted).toBe(true);
    expect(better.candidatePassRate).toBe(1);
    expect(better.incumbentPassRate).toBe(0);
    const equal = await validateAgainstTasks({
      corpus,
      runTask: async () => "PASS",
    });
    expect(equal.accepted).toBe(false);
    expect(equal.reason).toBe("no-improvement");
    const crashyCandidate = await validateAgainstTasks({
      corpus,
      runTask: async (_task, variant) => {
        if (variant === "candidate") {
          throw new Error("skill made the agent crash");
        }
        return "PASS";
      },
    });
    expect(crashyCandidate.accepted).toBe(false);
  });
});

// PLAN-44 Phase 2 — I5/I6 at the gate.
describe("runValidationGate (PLAN-44 Phase 2)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "valgate-p2-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function stage(name = "curl-timeout-guard") {
    await applyProposal(
      {
        action: "create",
        name,
        // PLAN-44 Phase 4b: each staged name gets a DISTINCT description, or
        // the overlap check refuses the second create as a near-duplicate.
        skillMd: SKILL_MD.replace("name: curl-timeout-guard", `name: ${name}`).replace(
          /^description: .*$/m,
          name === "curl-timeout-guard"
            ? "$&"
            : `description: ${name} ${name}-ops ${name}-mode when the task names ${name}; not for ${name}-less work.`,
        ),
        purposeMd: PURPOSE_MD,
      },
      { storeOpts: { configDir: tmpDir }, iteration: "it-p2" },
    );
  }
  async function growCorpus(n: number) {
    await fs.mkdir(path.dirname(corpusPath({ configDir: tmpDir })), { recursive: true });
    const lines = Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        id: `grown-${i}`,
        prompt: `grown task ${i}. Reply FINAL: <answer>.`,
        checker: { kind: "final", value: "PASS" },
        suite: "capability",
      }),
    );
    await fs.writeFile(corpusPath({ configDir: tmpDir }), `${lines.join("\n")}\n`, "utf-8");
  }
  /** Candidate wins every capability task; both arms pass every canonical task. */
  const winningRunner = async (task: { suite?: string }, variant: string) =>
    task.suite === "regression"
      ? { answer: "FINAL: unused", skillRead: false }
      : {
          answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
          skillRead: variant === "candidate",
        };

  it("auto-flips to tasks mode once the corpus has 5 reviewed capability tasks (D-2)", async () => {
    await stage();
    await growCorpus(5);
    // Canonical tasks need real answers; the runner answers them with the
    // checker value via a tiny oracle: we cannot know the fresh instance's
    // answer here, so make regression tasks identical across arms (ties).
    const outcomes = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: winningRunner,
      trialsPerTask: 1,
      modelTag: "test/model",
    });
    expect(outcomes[0]?.outcome).toBe("promoted");
    expect(outcomes[0]?.detail).toContain("tasks: accepted");
    const roots = resolveStorageRoots({ configDir: tmpDir });
    const meta = JSON.parse(
      await fs.readFile(
        path.join(roots.liveRoot, "curl-timeout-guard", ".evolution-meta.json"),
        "utf-8",
      ),
    ) as { validation: { mode: string; candidateReadRate?: { capability: number | null } } };
    expect(meta.validation.mode).toBe("tasks");
    expect(meta.validation.candidateReadRate?.capability).toBe(1);
  });

  it("stays on records mode below the threshold when no mode is configured (and HOLDs without a journal)", async () => {
    await stage();
    await growCorpus(2);
    const outcomes = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: winningRunner,
      trialsPerTask: 1,
    });
    expect(outcomes[0]?.outcome).toBe("held");
    expect(outcomes[0]?.detail).toContain("no journal/llm");
  });

  it("serves incumbent trials from the memo on the next proposal (same model, same day)", async () => {
    await growCorpus(5);
    const cache = TrialCache.inMemory();
    const calls = { incumbent: 0, candidate: 0 };
    const counting = async (task: { suite?: string }, variant: "incumbent" | "candidate") => {
      calls[variant] += 1;
      return winningRunner(task, variant);
    };
    await stage("skill-a");
    await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: counting,
      trialsPerTask: 1,
      modelTag: "test/model",
      trialCache: cache,
    });
    const firstIncumbent = calls.incumbent;
    expect(firstIncumbent).toBeGreaterThan(0);
    await stage("skill-b");
    await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: counting,
      trialsPerTask: 1,
      modelTag: "test/model",
      trialCache: cache,
    });
    // Both creates share the "no skill" incumbent: zero new incumbent runs.
    expect(calls.incumbent).toBe(firstIncumbent);
    expect(calls.candidate).toBe(firstIncumbent * 2);
  });

  it("HOLDs never-triggered and budget-exhausted; REJECTs over-triggered", async () => {
    await growCorpus(5);
    await stage("never");
    const never = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: async (task: { suite?: string }, variant: string) => ({
        answer:
          task.suite === "regression"
            ? "FINAL: x"
            : variant === "candidate"
              ? "FINAL: PASS"
              : "FINAL: nope",
        skillRead: false,
      }),
      trialsPerTask: 1,
    });
    expect(never[0]).toMatchObject({ outcome: "held" });
    expect(never[0]?.detail).toContain("never-triggered");
    await stage("over");
    const over = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: async (task: { suite?: string }, variant: string) => ({
        answer:
          task.suite === "regression"
            ? "FINAL: x"
            : variant === "candidate"
              ? "FINAL: PASS"
              : "FINAL: nope",
        skillRead: variant === "candidate",
      }),
      trialsPerTask: 1,
    });
    // "over" was staged after "never" (still held): settle order is sorted by name.
    const overOutcome = over.find((o) => o.skillName === "over");
    expect(overOutcome).toMatchObject({ outcome: "rejected" });
    expect(overOutcome?.detail).toContain("over-triggered");
    await stage("budget");
    const budget = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: winningRunner,
      trialsPerTask: 1,
      validationBudgetMinutes: 0,
    });
    const budgetOutcome = budget.find((o) => o.skillName === "budget");
    expect(budgetOutcome).toMatchObject({ outcome: "held" });
    expect(budgetOutcome?.detail).toContain("budget-exhausted");
  });
});

describe("runValidationGate: hold backoff and candidate memo (adversarial H2)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "valgate-h2-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not re-validate a held proposal within 24h unless content or corpus changed", async () => {
    await applyProposal(
      {
        action: "create",
        name: "held-skill",
        skillMd: SKILL_MD.replace("name: curl-timeout-guard", "name: held-skill").replace(
          /^description: .*$/m,
          "description: held-skill held-skill-ops held-skill-mode when the task names held-skill; not for held-skill-less work.",
        ),
        purposeMd: PURPOSE_MD,
      },
      { storeOpts: { configDir: tmpDir }, iteration: "h2" },
    );
    await fs.mkdir(path.dirname(corpusPath({ configDir: tmpDir })), { recursive: true });
    await fs.writeFile(
      corpusPath({ configDir: tmpDir }),
      Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({
          id: `g${i}`,
          prompt: `g ${i}`,
          checker: { kind: "final", value: "PASS" },
          suite: "capability",
        }),
      ).join("\n") + "\n",
      "utf-8",
    );
    let calls = 0;
    const neverRead = async (task: { suite?: string }, variant: string) => {
      calls += 1;
      return {
        answer:
          task.suite === "regression"
            ? "FINAL: x"
            : variant === "candidate"
              ? "FINAL: PASS"
              : "FINAL: nope",
        skillRead: false,
      };
    };
    const first = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: neverRead,
      trialsPerTask: 1,
      modelTag: "m",
    });
    expect(first[0]).toMatchObject({ outcome: "held" });
    expect(first[0]?.detail).toContain("never-triggered");
    const firstCalls = calls;
    const second = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: neverRead,
      trialsPerTask: 1,
      modelTag: "m",
    });
    expect(second[0]).toMatchObject({ outcome: "held" });
    expect(second[0]?.detail).toContain("retry after");
    expect(calls).toBe(firstCalls);
  });

  it("memoizes the candidate arm too, so a budget retry resumes instead of restarting", async () => {
    await applyProposal(
      {
        action: "create",
        name: "memo-skill",
        skillMd: SKILL_MD.replace("name: curl-timeout-guard", "name: memo-skill").replace(
          /^description: .*$/m,
          "description: memo-skill memo-skill-ops memo-skill-mode when the task names memo-skill; not for memo-skill-less work.",
        ),
        purposeMd: PURPOSE_MD,
      },
      { storeOpts: { configDir: tmpDir }, iteration: "h2" },
    );
    await fs.mkdir(path.dirname(corpusPath({ configDir: tmpDir })), { recursive: true });
    await fs.writeFile(
      corpusPath({ configDir: tmpDir }),
      Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({
          id: `g${i}`,
          prompt: `g ${i}`,
          checker: { kind: "final", value: "PASS" },
          suite: "capability",
        }),
      ).join("\n") + "\n",
      "utf-8",
    );
    const cache = TrialCache.inMemory();
    const calls = { incumbent: 0, candidate: 0 };
    const runner = async (task: { suite?: string }, variant: "incumbent" | "candidate") => {
      calls[variant] += 1;
      return {
        answer:
          task.suite === "regression"
            ? "FINAL: x"
            : variant === "candidate"
              ? "FINAL: PASS"
              : "FINAL: nope",
        // Read only where it applies (a read on regression tasks is over-triggering).
        skillRead: variant === "candidate" ? task.suite !== "regression" : null,
      };
    };
    await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: runner,
      trialsPerTask: 1,
      modelTag: "m",
      trialCache: cache,
      validationBudgetMinutes: -1,
    });
    // Deadline in the past: nothing ran — HOLD (budget-exhausted), no calls.
    expect(calls.candidate).toBe(0);
    const result = await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: runner,
      trialsPerTask: 1,
      modelTag: "m",
      trialCache: cache,
    });
    // budget-exhausted is never backed off (the memo makes a retry a resume):
    // the second pass runs and fills the memo for both arms.
    expect(result[0]?.outcome).toBe("promoted");
    expect(cache.size()).toBe(calls.incumbent + calls.candidate);
    // A third pass would be served entirely from the memo.
    await applyProposal(
      {
        action: "create",
        name: "memo-skill-2",
        skillMd: SKILL_MD.replace("name: curl-timeout-guard", "name: memo-skill-2").replace(
          /^description: .*$/m,
          "description: memo-skill-2 memo-skill-2-ops memo-skill-2-mode when the task names memo-skill-2; not for memo-skill-2-less work.",
        ),
        purposeMd: PURPOSE_MD,
      },
      { storeOpts: { configDir: tmpDir }, iteration: "h2" },
    );
    const before = { ...calls };
    await runValidationGate({
      journal: null,
      llmCall: null,
      storeOpts: { configDir: tmpDir },
      runTask: runner,
      trialsPerTask: 1,
      modelTag: "m",
      trialCache: cache,
    });
    // Same "no skill" incumbent: served from the memo; new candidate: fresh.
    expect(calls.incumbent).toBe(before.incumbent);
    expect(calls.candidate).toBeGreaterThan(before.candidate);
  });
});

describe("origin-bound evidence (PLAN-44 Phase 3)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "valgate-p3-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function stageWith(origins: string[]) {
    await applyProposal(
      { action: "create", name: "curl-timeout-guard", skillMd: SKILL_MD, purposeMd: PURPOSE_MD },
      {
        storeOpts: { configDir: tmpDir },
        iteration: "it-p3",
        evidence: { runIds: ["r1", "r2"], origins },
      },
    );
  }

  it("HOLDs a proposal whose cited traces are all third-party, before any LLM spend", async () => {
    await stageWith(["circle", "a2a"]);
    let llmCalls = 0;
    const outcomes = await runValidationGate({
      journal: heldOutJournal(),
      llmCall: async () => {
        llmCalls += 1;
        return scoresAccepting(8);
      },
      storeOpts: { configDir: tmpDir },
      modelTag: "test/model-1",
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: "held", detail: "untrusted-evidence-only" }),
    ]);
    expect(llmCalls).toBe(0);
    const roots = resolveStorageRoots({ configDir: tmpDir });
    expect(await readLive(roots, "curl-timeout-guard")).toBeNull();
    const purpose = await fs.readFile(
      path.join(roots.stagingRoot, "curl-timeout-guard", "PURPOSE.md"),
      "utf-8",
    );
    expect(purpose).toContain("## Evidence");
    expect(purpose).toContain("origins: circle, a2a");
  });

  it("proceeds when at least one cited trace is first-party", async () => {
    await stageWith(["circle", "human"]);
    const outcomes = await runValidationGate({
      journal: heldOutJournal(),
      llmCall: orderAware(() => scoresAccepting(8)),
      storeOpts: { configDir: tmpDir },
      modelTag: "test/model-1",
    });
    expect(outcomes[0]?.detail).not.toBe("untrusted-evidence-only");
  });
});

describe("staged-content tamper check (PLAN-44 Phase 3 adversarial H1)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "valgate-tamper-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects and discards a staged SKILL.md that no longer matches the pipeline's hash, spending nothing", async () => {
    await applyProposal(
      { action: "create", name: "curl-timeout-guard", skillMd: SKILL_MD, purposeMd: PURPOSE_MD },
      {
        storeOpts: { configDir: tmpDir },
        iteration: "it-t",
        evidence: { runIds: ["r1"], origins: ["human"] },
      },
    );
    const roots = resolveStorageRoots({ configDir: tmpDir });
    // A direct write bypassing stageSkill (which would have stripped the meta).
    await fs.writeFile(
      path.join(roots.stagingRoot, "curl-timeout-guard", "SKILL.md"),
      SKILL_MD.replace("--max-time", "--insecure"),
    );
    let llmCalls = 0;
    const outcomes = await runValidationGate({
      journal: heldOutJournal(),
      llmCall: async () => {
        llmCalls += 1;
        return scoresAccepting(8);
      },
      storeOpts: { configDir: tmpDir },
      modelTag: "test/model-1",
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: "rejected", detail: "staged content tampered" }),
    ]);
    expect(llmCalls).toBe(0);
    expect(await readLive(roots, "curl-timeout-guard")).toBeNull();
    await expect(
      fs.access(path.join(roots.stagingRoot, "curl-timeout-guard", "SKILL.md")),
    ).rejects.toThrow();
  });
});

describe("description repair loop (PLAN-44 Phase 4a)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "valgate-repair-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const REWORDED =
    "Bound curl with --max-time whenever a grown task shells out to curl; never for arithmetic or file reads.";
  async function growAndStage() {
    await fs.mkdir(path.dirname(corpusPath({ configDir: tmpDir })), { recursive: true });
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        id: `grown-${i}`,
        prompt: `grown task ${i}: run curl. Reply FINAL: <answer>.`,
        checker: { kind: "final", value: "PASS" },
        suite: "capability",
      }),
    );
    await fs.writeFile(corpusPath({ configDir: tmpDir }), `${lines.join("\n")}\n`, "utf-8");
    await applyProposal(
      { action: "create", name: "curl-timeout-guard", skillMd: SKILL_MD, purposeMd: PURPOSE_MD },
      {
        storeOpts: { configDir: tmpDir },
        iteration: "it-r",
        evidence: { runIds: ["r1"], origins: ["human"] },
      },
    );
  }
  const neverRead = async (task: { suite?: string }, variant: string) => ({
    answer:
      task.suite === "regression"
        ? "FINAL: x"
        : variant === "candidate"
          ? "FINAL: PASS"
          : "FINAL: nope",
    skillRead: false,
  });
  function repairingLlm() {
    let calls = 0;
    const llmCall = async (prompt: string) => {
      calls += 1;
      if (prompt.includes('"descriptions"')) {
        return JSON.stringify({ descriptions: [REWORDED] });
      }
      const desc = prompt.match(/<description>(.*)<\/description>/)?.[1] ?? "";
      const lines = prompt.split("\n").filter((l) => /^\d+\. /.test(l));
      return JSON.stringify({ reads: lines.map((l) => desc === REWORDED && /grown task/.test(l)) });
    };
    return { llmCall, count: () => calls };
  }

  it("rewrites the staged description after never-triggered, re-keys the meta hash, and records it", async () => {
    await growAndStage();
    const llm = repairingLlm();
    const outcomes = await runValidationGate({
      journal: null,
      llmCall: llm.llmCall,
      storeOpts: { configDir: tmpDir },
      runTask: neverRead,
      trialsPerTask: 1,
      modelTag: "m",
    });
    expect(outcomes[0]).toMatchObject({ outcome: "held" });
    expect(outcomes[0]?.detail).toContain("description repaired");
    expect(llm.count()).toBeGreaterThan(0);
    const roots = resolveStorageRoots({ configDir: tmpDir });
    const staged = await fs.readFile(
      path.join(roots.stagingRoot, "curl-timeout-guard", "SKILL.md"),
      "utf-8",
    );
    expect(staged).toContain(`description: ${REWORDED}`);
    expect(staged).toContain("--max-time 30");
    const meta = JSON.parse(
      await fs.readFile(
        path.join(roots.stagingRoot, "curl-timeout-guard", ".evolution-meta.json"),
        "utf-8",
      ),
    ) as {
      contentHash: string;
      descriptionRepairs: number;
      descriptionRepairLog: unknown[];
      lastValidation: { contentHash: string };
    };
    expect(meta.descriptionRepairs).toBe(1);
    expect(meta.descriptionRepairLog).toHaveLength(1);
    expect(meta.contentHash).not.toBe(meta.lastValidation.contentHash);
    const trail = await readProvenance({ configDir: tmpDir });
    expect(
      trail.some((e) => e.verdict === "staged" && /description repaired/.test(e.detail ?? "")),
    ).toBe(true);
    // The repaired content is NOT under backoff: the next pass re-measures it (tamper check passes).
    const second = await runValidationGate({
      journal: null,
      llmCall: llm.llmCall,
      storeOpts: { configDir: tmpDir },
      runTask: neverRead,
      trialsPerTask: 1,
      modelTag: "m",
    });
    expect(second[0]?.detail).toContain("never-triggered");
    expect(second[0]?.detail).not.toContain("tampered");
  });

  it("stops at the repair cap and honours the kill switch", async () => {
    await growAndStage();
    const roots = resolveStorageRoots({ configDir: tmpDir });
    const metaPath = path.join(roots.stagingRoot, "curl-timeout-guard", ".evolution-meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8")) as Record<string, unknown>;
    await fs.writeFile(metaPath, JSON.stringify({ ...meta, descriptionRepairs: 2 }));
    const llm = repairingLlm();
    const capped = await runValidationGate({
      journal: null,
      llmCall: llm.llmCall,
      storeOpts: { configDir: tmpDir },
      runTask: neverRead,
      trialsPerTask: 1,
    });
    expect(capped[0]?.detail).toContain("never-triggered");
    expect(capped[0]?.detail).not.toContain("repair");
    expect(llm.count()).toBe(0);

    await fs.writeFile(metaPath, JSON.stringify({ ...meta, descriptionRepairs: 0 }));
    const off = await runValidationGate({
      journal: null,
      llmCall: llm.llmCall,
      storeOpts: { configDir: tmpDir },
      runTask: neverRead,
      trialsPerTask: 1,
      descriptionRepair: false,
    });
    expect(off[0]?.detail).not.toContain("repair");
    expect(llm.count()).toBe(0);
  });
});
