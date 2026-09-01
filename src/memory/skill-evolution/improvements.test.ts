import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CorpusTask } from "./task-corpus.js";
import { composeTaskPrompt, makeInjectedSkillRunner } from "./task-runner.js";
import { runSemanticLint } from "./wiki-semantic-lint.js";
import {
  applyMaintainerOutput,
  type MaintainerOutput,
  parseMaintainerOutput,
  readSchema,
  readWikiContext,
  schemaPath,
  listPatternNames,
} from "./wiki-store.js";

function out(partial: Partial<MaintainerOutput>): MaintainerOutput {
  return { createPatterns: [], updatePatterns: [], updateIndex: "- i", appendLog: "l", ...partial };
}

describe("#3 schema layer (Karpathy Layer 3)", () => {
  let tmpDir: string;
  const opts = () => ({ configDir: tmpDir });
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "schema-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("seeds a default schema on first apply and exposes it in the wiki context", async () => {
    await applyMaintainerOutput(out({}), opts());
    const onDisk = await fs.readFile(schemaPath(opts()), "utf-8");
    expect(onDisk).toContain("# Wiki Schema");
    const ctx = await readWikiContext(opts());
    expect(ctx.schema).toContain("Pattern page conventions");
  });

  it("lets the maintainer evolve the schema via update_schema", async () => {
    await applyMaintainerOutput(out({}), opts());
    const result = await applyMaintainerOutput(
      out({ updateSchema: "# Wiki Schema\n\nNEW CONVENTION: name patterns by tool." }),
      opts(),
    );
    expect(result.schemaUpdated).toBe(true);
    expect(await readSchema(opts())).toContain("NEW CONVENTION");
  });

  it("parses update_schema from maintainer JSON", () => {
    const { output } = parseMaintainerOutput(
      JSON.stringify({ update_index: "i", append_log: "l", update_schema: "# S" }),
    );
    expect(output?.updateSchema).toBe("# S");
  });
});

describe("#1 tasks runner: full skill injection", () => {
  const task: CorpusTask = {
    id: "t1",
    prompt: "What is 2+2?",
    checker: { kind: "contains", value: "4" },
  };

  it("injects the candidate body but leaves incumbent-none bare (create case)", async () => {
    const seen: Array<{ variant: string; prompt: string }> = [];
    const runner = makeInjectedSkillRunner(
      async (prompt) => {
        seen.push({ variant: prompt.includes("BEGIN SKILL") ? "injected" : "bare", prompt });
        return "answer 4";
      },
      "---\nname: adder\n---\nAlways compute carefully.",
      null,
    );
    await runner(task, "candidate");
    await runner(task, "incumbent");
    expect(seen[0]).toMatchObject({ variant: "injected" });
    expect(seen[0]?.prompt).toContain("Always compute carefully");
    expect(seen[0]?.prompt).toContain("What is 2+2?");
    expect(seen[1]).toMatchObject({ variant: "bare" });
    expect(seen[1]?.prompt).toBe("What is 2+2?");
  });

  it("composeTaskPrompt wraps the skill body in delimiters", () => {
    expect(composeTaskPrompt(task, null)).toBe("What is 2+2?");
    const composed = composeTaskPrompt(task, "SKILL BODY");
    expect(composed).toContain("--- BEGIN SKILL ---\nSKILL BODY\n--- END SKILL ---");
  });
});

describe("#2 semantic lint", () => {
  let tmpDir: string;
  const opts = () => ({ configDir: tmpDir });
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "semlint-"));
    // Seed 5 patterns so the min-kept floor allows some archiving.
    await applyMaintainerOutput(
      out({
        createPatterns: [
          { name: "p-old", content: "curl 404s always" },
          { name: "p-new", content: "curl works now, use --max-time" },
          { name: "p-c", content: "c" },
          { name: "p-d", content: "d" },
          { name: "p-e", content: "e" },
        ],
        updateIndex: "- patterns",
      }),
      opts(),
    );
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("archives a page the model marks superseded, keeping the rest", async () => {
    const res = await runSemanticLint({
      llmCall: async () =>
        JSON.stringify([
          {
            type: "stale",
            pages: ["p-new", "p-old"],
            action: "archive",
            detail: "p-old superseded by p-new",
          },
        ]),
      storeOpts: opts(),
    });
    expect(res.ran).toBe(true);
    expect(res.archived).toEqual(["p-old"]);
    const remaining = await listPatternNames(opts());
    expect(remaining).toContain("p-new");
    expect(remaining).not.toContain("p-old");
    // logs.md records the lint pass.
    const logs = await fs.readFile(path.join(tmpDir, "skill-wiki", "logs.md"), "utf-8");
    expect(logs).toContain("semantic lint");
  });

  it("only flags contradictions (never archives them)", async () => {
    const res = await runSemanticLint({
      llmCall: async () =>
        JSON.stringify([
          { type: "contradiction", pages: ["p-c", "p-d"], action: "flag", detail: "conflict" },
        ]),
      storeOpts: opts(),
    });
    expect(res.archived).toHaveLength(0);
    expect(res.contradictionsFlagged).toBe(1);
    expect(await listPatternNames(opts())).toHaveLength(5);
  });

  it("no-ops without an LLM and handles unparseable output", async () => {
    expect((await runSemanticLint({ llmCall: null, storeOpts: opts() })).reason).toBe("no-llm");
    const bad = await runSemanticLint({ llmCall: async () => "no json here", storeOpts: opts() });
    expect(bad.reason).toBe("parse-failed");
  });
});
