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
import { validateAgainstTasks } from "./validate-tasks.js";
import { runValidationGate } from "./validation-gate.js";

const SKILL_MD =
  "---\nname: curl-timeout-guard\ndescription: Always bound curl with --max-time; apply when running curl in exec.\n---\n\n## When to Apply\nAny exec call invoking curl.\n\n## When NOT to Apply\nNon-network commands.\n\nAlways pass --max-time 30.";
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
      llmCall: async () => scoresAccepting(8),
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
      llmCall: async () => scoresRejecting(8),
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
      llmCall: async () => scoresAccepting(8),
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
      llmCall: async () => scoresRejecting(8),
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
      llmCall: async () => scoresAccepting(8),
      storeOpts: { configDir: tmpDir },
      maxActiveEvolved: 0,
    });
    expect(outcomes[0]).toMatchObject({ outcome: "held" });
    const roots = resolveStorageRoots({ configDir: tmpDir });
    expect(await readLive(roots, "curl-timeout-guard")).toBeNull();
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
    expect(corpus?.tasks.length).toBe(12);
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
