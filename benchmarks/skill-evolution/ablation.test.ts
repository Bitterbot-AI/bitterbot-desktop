import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_EXEMPLAR_SHA256,
  CANONICAL_GENERATOR_VERSION,
} from "../../src/memory/skill-evolution/canonical-corpus.js";
import { checkCommittedReport, runAblation } from "./ablation.js";
import { listLiveSkillOrigins, resolveArms } from "./ablation/arms.js";
import {
  type ArmKind,
  type CorpusId,
  type ModelId,
  capTasks,
  planTrials,
} from "./ablation/plan.js";
import { parseReportHeader, verdictSentence } from "./ablation/report.js";
import { armStats, pairedStats, type TrialRecord } from "./ablation/stats.js";

const rec = (over: Partial<TrialRecord>): TrialRecord => ({
  arm: "none",
  corpus: "frozen",
  model: "primary",
  taskId: "t",
  suite: "capability",
  trialIndex: 0,
  pass: 1,
  tokensIn: 100,
  tokensOut: 10,
  wallMs: 1,
  skillRead: null,
  cacheRead: 0,
  error: null,
  ...over,
});

describe("PLAN-45 5.1 ablation harness", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ablation-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("plans deterministically: regression-first cap, arms x corpora x models x tasks x trials", () => {
    const tasks = [
      {
        id: "cap-b",
        prompt: "p",
        checker: { kind: "final" as const, value: "x" },
        suite: "capability",
      },
      {
        id: "reg-a",
        prompt: "p",
        checker: { kind: "final" as const, value: "x" },
        suite: "regression",
      },
      {
        id: "cap-a",
        prompt: "p",
        checker: { kind: "final" as const, value: "x" },
        suite: "capability",
      },
    ];
    // Per suite (adversarial 5-2): the cap never removes the capability tasks.
    expect(capTasks(tasks, 1).map((t) => t.id)).toEqual(["cap-a", "reg-a"]);
    expect(capTasks(tasks, 0).map((t) => t.id)).toEqual(["cap-a", "cap-b", "reg-a"]);
    const trials = planTrials({
      arms: [
        { id: "none", skillNames: [], contextBlock: null, note: null },
        { id: "evolved", skillNames: [], contextBlock: null, note: "empty" },
        { id: "harvested", skillNames: ["h"], contextBlock: null, note: null },
      ],
      corpora: [{ id: "frozen", version: "v", tasks, note: null }],
      models: [{ id: "primary", spec: "p/m" }],
      trialsPerTask: 2,
      cap: 0,
    });
    // The empty evolved arm is skipped; none + harvested x 3 tasks x 2 trials.
    expect(trials).toHaveLength(12);
    expect(trials[0]?.key).toBe("primary|frozen|none|cap-a|0");
  });

  it("stats: pass@1, pass^K, read rate, paired sign test and CI against the baseline", () => {
    const arm: TrialRecord[] = [];
    const base: TrialRecord[] = [];
    for (let t = 0; t < 8; t++) {
      for (let i = 0; i < 3; i++) {
        arm.push(
          rec({
            arm: "evolved",
            taskId: `t${t}`,
            trialIndex: i,
            pass: 1,
            skillRead: true,
            tokensIn: 200,
          }),
        );
        base.push(rec({ taskId: `t${t}`, trialIndex: i, pass: t < 2 ? 1 : 0, tokensIn: 100 }));
      }
    }
    // One regression task never enters the paired test.
    arm.push(rec({ arm: "evolved", taskId: "reg", suite: "regression", pass: 0 }));
    const s = armStats(arm, 3);
    // The regression trial's read is unobservable (null) and stays out of the read rate.
    expect(s).toMatchObject({ arm: "evolved", tasks: 9, trials: 25, k: 3, readRate: 1 });
    expect(s?.passAt1).toBeCloseTo(24 / 25, 5);
    expect(s?.passPowK).toBeCloseTo(8 / 9, 5);
    const p = pairedStats(arm, base);
    expect(p).toMatchObject({
      arm: "evolved",
      baseline: "none",
      n: 8,
      wins: 6,
      losses: 0,
      ties: 2,
    });
    expect(p?.pValue).toBeCloseTo(0.5 ** 6, 6);
    expect(p?.tokenDelta).toBeCloseTo(210 / 110 - 1, 5); // in + out tokens per trial
    expect(p?.ci95Low).toBeGreaterThan(0);
    expect(verdictSentence(p!)).toContain("beat");
    const tie = pairedStats(base, base);
    expect(verdictSentence(tie!)).toContain("did not");
    const loss = pairedStats(base, arm);
    expect(verdictSentence(loss!)).toContain("LOST to");
    expect(p?.credited.wins).toBe(6);
    expect(verdictSentence({ ...p!, n: 3 })).toContain("Underpowered");
  });

  it("resolves arms from the live root by origin sidecars", async () => {
    const live = path.join(tmp, "skills");
    const mk = async (name: string, sidecar?: [string, string]) => {
      await fs.mkdir(path.join(live, name), { recursive: true });
      await fs.writeFile(
        path.join(live, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: d\n---\nb\n`,
      );
      if (sidecar) {
        await fs.writeFile(path.join(live, name, sidecar[0]), sidecar[1]);
      }
    };
    await mk("evolved-a", [
      ".evolution-meta.json",
      JSON.stringify({
        origin: "wiki-evolution",
        ladder: { state: "stable" },
        evidence: { runIds: ["r1"], origins: ["human"] },
      }),
    ]);
    await mk("evolved-off", [
      ".evolution-meta.json",
      JSON.stringify({ origin: "wiki-evolution", ladder: { state: "canary-off" } }),
    ]);
    await mk("harvested-a", [
      ".provenance.json",
      JSON.stringify({ author_pubkey: "PK", content_hash: "h" }),
    ]);
    await mk("registry-a", [
      ".provenance.json",
      JSON.stringify({ registry: "agentskills.io", slug: "x" }),
    ]);
    await mk("local-a");
    const origins = await listLiveSkillOrigins(tmp);
    expect(origins.map((o) => [o.name, o.origin])).toEqual([
      ["evolved-a", "evolved"],
      ["harvested-a", "harvested"],
      ["local-a", "local"],
      ["registry-a", "harvested"],
    ]);
    const { arms } = await resolveArms({
      ids: ["none", "harvested", "evolved", "in-context"],
      configDir: tmp,
      journal: null,
    });
    expect(arms.map((a) => [a.id, a.skillNames, a.note])).toEqual([
      ["none", [], null],
      ["harvested", ["harvested-a", "registry-a"], null],
      ["evolved", ["evolved-a"], null],
      ["in-context", [], "event journal unavailable; evidence traces cannot be rendered"],
    ]);
  });

  it("I10: the oracle run regenerates byte-identical (modulo timestamp), exercises every arm and pair, and --check binds a committed report to the corpus pin", async () => {
    // Fixture node: one harvested skill, one evolved skill with evidence.
    const live = path.join(tmp, "skills");
    for (const [name, sidecar, body] of [
      ["harv", ".provenance.json", JSON.stringify({ author_pubkey: "PK", content_hash: "h" })],
      [
        "evo",
        ".evolution-meta.json",
        JSON.stringify({
          origin: "wiki-evolution",
          ladder: { state: "stable" },
          evidence: { runIds: ["r1", "r2", "r3"], origins: ["human"] },
        }),
      ],
    ] as const) {
      await fs.mkdir(path.join(live, name), { recursive: true });
      await fs.writeFile(
        path.join(live, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: d\n---\nb\n`,
      );
      await fs.writeFile(path.join(live, name, sidecar), body);
    }
    const { makeFixtureJournal, appendFixtureRun } =
      await import("../../src/memory/skill-evolution/__fixtures__/journal-fixture.js");
    const journal = makeFixtureJournal();
    for (const id of ["r1", "r2", "r3"]) {
      appendFixtureRun(journal, {
        runId: id,
        task: { text: "t" },
        steps: [{ kind: "tool", name: "exec", args: { command: "ls" } }],
        completedExplicitly: true,
      });
    }
    const out = path.join(tmp, "reports", "skills-2026-09-06.md");
    const opts = {
      arms: ["none", "harvested", "evolved", "in-context"] as ArmKind[],
      corpora: ["frozen", "fresh"] as CorpusId[],
      models: ["primary"] as ModelId[],
      trials: 2,
      cap: 6,
      seed: 7,
      executor: "oracle" as const,
      out,
      freshContext: false,
      configDir: tmp,
      argv: ["--executor", "oracle"],
      journal,
      yes: true,
    };
    const a = await runAblation(opts);
    const b = await runAblation({ ...opts, out: null });
    const strip = (md: string) =>
      md
        .replace(/"generatedAt": "[^"]+"/, "")
        .replace(/\s*"reportDate": "[^"]+",?/, "")
        .replace(/^# Skill ablation .*$/m, "");
    expect(strip(b.markdown)).toBe(strip(a.markdown));
    // 6 capability + 6 regression per corpus, 2 corpora, 2 trials, 5 arms
    // (none, harvested, evolved, evolved:evo, in-context:evo).
    expect(a.records.length).toBe(12 * 2 * 2 * 5);
    const header = parseReportHeader(a.markdown);
    expect(header).toMatchObject({
      executor: "oracle",
      generatorVersion: CANONICAL_GENERATOR_VERSION,
      exemplarSha256: CANONICAL_EXEMPLAR_SHA256,
      corpusVersions: { frozen: "canonical-g5-s0", fresh: "canonical-g5-s7" },
      nodeState: { live: 2, evolved: 1, harvested: 1, privateTasks: 0 },
    });
    expect(a.markdown).toContain("evolved:evo vs in-context:evo");
    expect(a.markdown).toContain("harvested vs none");
    expect(a.markdown).toContain("Executor: ORACLE");
    // A paired comparison has capability tasks to work with (adversarial 5-2).
    expect(a.markdown).not.toContain("Underpowered: 0 paired");
    // An oracle report is never committed as evidence: --check refuses it, and
    // the CLI refuses to write it under docs/benchmarks.
    const check = await checkCommittedReport(path.dirname(out), tmp);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("executor oracle");
    await expect(
      runAblation({ ...opts, out: path.join(tmp, "docs", "benchmarks", "skills-2026-09-06.md") }),
    ).rejects.toThrow(/oracle executor never writes under docs\/benchmarks/);
    // A committed (embedded) report with the right pin passes; a drifted one fails.
    const embedded = (await fs.readFile(out, "utf-8")).replace(
      '"executor": "oracle"',
      '"executor": "embedded"',
    );
    await fs.writeFile(out, embedded);
    expect((await checkCommittedReport(path.dirname(out), tmp)).ok).toBe(true);
    await fs.writeFile(
      out,
      embedded.replace(
        `"generatorVersion": ${CANONICAL_GENERATOR_VERSION}`,
        '"generatorVersion": 1',
      ),
    );
    const bad = await checkCommittedReport(path.dirname(out), tmp);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("generatorVersion");
  });
});
