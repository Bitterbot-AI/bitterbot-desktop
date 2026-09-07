import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseNumericAnswer,
  scoreTaskAnswer,
} from "../../../src/memory/skill-evolution/task-corpus.js";
import { csbTask, loadContinualSkillBench } from "./continual-skill-bench.js";

describe("PLAN-45 5.5: ContinualSkillBench as an external corpus", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "csb-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("numeric checker: FINAL line, currency/percent/thousands normalization, tolerance", () => {
    expect(parseNumericAnswer("$37,921,314")).toBe(37921314);
    expect(parseNumericAnswer("13.0%")).toBe(13);
    expect(parseNumericAnswer("abc")).toBeNull();
    const task = {
      id: "t",
      prompt: "p",
      checker: { kind: "numeric" as const, value: "41932.20339", tolerance: 0.0001 },
    };
    expect(scoreTaskAnswer(task, "working...\nFINAL: 41932.2034")).toBe(1);
    expect(scoreTaskAnswer(task, "FINAL: $41,932.20339")).toBe(1);
    expect(scoreTaskAnswer(task, "FINAL: 41932.3")).toBe(0);
    expect(scoreTaskAnswer(task, "41932.20339")).toBe(0); // no FINAL line
  });

  it("imports only exact_match and numeric subtasks, with ids, tags and checkers, and counts the rest", async () => {
    const dir = path.join(tmp, "Continual-Skill-Bench", "tasks", "math-100", "environment");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tasks_spec.json"),
      JSON.stringify([
        {
          task_id: 1,
          instruction: "What is n?",
          eval_type: "exact_match",
          answer: "A",
          skill_layer: 1,
          skill_tags: ["basic_algebra_computation"],
        },
        {
          task_id: 2,
          instruction: "Compute x.",
          eval_type: "numeric",
          answer: "55",
          numeric_tolerance: 0.0001,
          skill_layer: 2,
        },
        {
          task_id: 3,
          instruction: "Prove it.",
          eval_type: "rubric_judge",
          answer: null,
          rubrics: ["..."],
        },
        { task_id: 4, instruction: "Run it.", eval_type: "programmatic", answer: "x" },
        { task_id: 5, instruction: "Empty.", eval_type: "exact_match", answer: "" },
      ]),
    );
    const loaded = await loadContinualSkillBench(tmp, { domains: ["math", "science"] });
    expect(loaded.domains).toEqual(["math-100"]);
    expect(loaded.skipped).toEqual({ rubric_judge: 1, programmatic: 1, exact_match: 1 });
    expect(loaded.tasks.map((t) => [t.id, t.checker.kind, t.tags?.slice(0, 4)])).toEqual([
      ["csb-math-001", "regex", ["external", "csb", "math", "layer-1"]],
      ["csb-math-002", "numeric", ["external", "csb", "math", "layer-2"]],
    ]);
    expect(loaded.tasks[0]?.prompt).toContain("FINAL: <answer>");
    expect(loaded.tasks[0]?.prompt).toContain("letter of the correct choice");
    // A choice letter is accepted bare or in parentheses, on the FINAL line only.
    const choice = loaded.tasks[0]!;
    expect(scoreTaskAnswer(choice, "reasoning...\nFINAL: (A)")).toBe(1);
    expect(scoreTaskAnswer(choice, "FINAL: A.")).toBe(1);
    expect(scoreTaskAnswer(choice, "FINAL: a")).toBe(1);
    expect(scoreTaskAnswer(choice, "FINAL: B")).toBe(0);
    expect(scoreTaskAnswer(choice, "the answer is A")).toBe(0);
    expect(scoreTaskAnswer(choice, "FINAL: AB")).toBe(0);
    expect(loaded.tasks[1]?.checker).toMatchObject({ value: "55", tolerance: 0.0001 });
    expect(
      csbTask("law-100", { task_id: 9, instruction: "x", eval_type: "f1", answer: "y" }),
    ).toBeNull();
  });
});
