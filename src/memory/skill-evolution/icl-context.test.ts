import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { makeContextRunner } from "./context-runner.js";
import { buildIclContext, ICL_CONTEXT_HEADER, iclCachePath } from "./icl-context.js";

describe("PLAN-45 5.2: in-context control arm", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "icl-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("renders the cited evidence traces verbatim and blind, caps and caches them, names the missing ones", async () => {
    const journal = makeFixtureJournal();
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) {
      appendFixtureRun(journal, {
        runId: id,
        task: { text: `run curl against the flaky host (${id})` },
        steps: [
          {
            kind: "tool",
            name: "exec",
            args: { command: `curl --max-time 5 ${id}.example` },
            result: "ok",
          },
        ],
        completedExplicitly: id !== "r2",
        terminal: id === "r2" ? "error" : "end",
      });
    }
    const ctx = await buildIclContext({
      journal,
      skillName: "curl-timeout-guard",
      runIds: ["r1", "r2", "gone", "r3", "r4", "r5"],
      storeOpts: { configDir: tmp },
      now: 5,
    });
    expect(ctx.renderedRunIds).toEqual(["r1", "r2", "r3", "r4"]);
    expect(ctx.missingRunIds).toEqual(["gone"]);
    expect(ctx.droppedRunIds).toEqual(["r5"]);
    expect(ctx.usable).toBe(true);
    expect(ctx.block.startsWith(ICL_CONTEXT_HEADER)).toBe(true);
    expect(ctx.block).toContain("- traces/r2: ended with an error");
    expect(ctx.block).toContain("curl --max-time 5 r1.example");
    // Blind: no labeler verdict lines, no "apply" instruction.
    expect(ctx.block).not.toMatch(/outcome:|apply its guidance/i);
    expect(ctx.journalMaxSeq).toBeGreaterThan(0);
    // Cached by evidence set; a re-read returns the same bytes.
    const file = iclCachePath("curl-timeout-guard", ["r1", "r2", "gone", "r3", "r4", "r5"], {
      configDir: tmp,
    });
    await expect(fs.access(file)).resolves.toBeUndefined();
    const again = await buildIclContext({
      journal,
      skillName: "curl-timeout-guard",
      runIds: ["r1", "r2", "gone", "r3", "r4", "r5"],
      storeOpts: { configDir: tmp },
    });
    expect(again.contentHash).toBe(ctx.contentHash);
    expect(again.renderedAt).toBe(5);
    // Too few reconstructed runs: the arm is not usable, and says which are missing.
    const thin = await buildIclContext({
      journal,
      skillName: "thin",
      runIds: ["r1", "x", "y"],
      storeOpts: { configDir: tmp },
    });
    expect(thin.usable).toBe(false);
    expect(thin.missingRunIds).toEqual(["x", "y"]);
  });

  it("the context runner prepends the block to the task prompt, writes no skill file, and keeps egress accounting", async () => {
    const prompts: string[] = [];
    const runner = makeContextRunner({
      agentTurn: async (prompt, opts) => {
        prompts.push(prompt);
        const entries = await fs
          .readdir(opts?.workspaceDir ?? "/nonexistent")
          .catch(() => ["MISSING"]);
        return { text: `FINAL: ${entries.includes("skills") ? "has-skills-dir" : "PASS"}` };
      },
      candidateContext: "CONTEXT BLOCK",
      incumbentContext: null,
      proposalId: "icl-test",
      storeOpts: { configDir: tmp },
    });
    const task = {
      id: "t1",
      prompt: "do the thing. Reply FINAL: <answer>.",
      checker: { kind: "final" as const, value: "PASS" },
      suite: "capability",
    };
    const cand = await runner(task, "candidate", { trialIndex: 0 });
    const inc = await runner(task, "incumbent", { trialIndex: 0 });
    expect(cand.answer).toBe("FINAL: PASS");
    expect(inc.answer).toBe("FINAL: PASS");
    expect(prompts[0]).toBe("CONTEXT BLOCK\n\ndo the thing. Reply FINAL: <answer>.");
    expect(prompts[1]).toBe("do the thing. Reply FINAL: <answer>.");
    expect(cand.skillRead).toBeNull();
    expect(cand.egress).toEqual([]);
  });
});
