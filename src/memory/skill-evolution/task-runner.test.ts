/**
 * PLAN-44 Phase 2 — I4: the gate's candidate arm is the RUNTIME PATHWAY.
 * The prompt carries the index entry and never the body; the body sits in
 * a scratch workspace; whether the agent read it comes from the journal.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import {
  composeRuntimePathwayPrompt,
  detectSkillRead,
  makeGatewayAgentTurn,
  makeRuntimePathwayRunner,
  parseSkillFrontmatter,
  trialsRoot,
} from "./task-runner.js";

const SKILL = `---
name: curl-timeout-guard
description: Bound every curl in exec with --max-time; apply when running curl.
---

## When to Apply
Any exec call invoking curl.

## Rule
Always pass \`--max-time 30\`.
`;

const TASK = {
  id: "cap-1",
  prompt: "Run the shell command `echo hi` and report the output.",
  checker: { kind: "final" as const, value: "hi" },
  suite: "capability" as const,
};

describe("runtime pathway prompt", () => {
  it("carries name/description/location and the selection rule, never the body", () => {
    const fm = parseSkillFrontmatter(SKILL);
    expect(fm).toEqual({
      name: "curl-timeout-guard",
      description: "Bound every curl in exec with --max-time; apply when running curl.",
    });
    const prompt = composeRuntimePathwayPrompt(TASK, {
      name: fm.name!,
      description: fm.description,
      location: "/tmp/x/skills/curl-timeout-guard/SKILL.md",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>curl-timeout-guard</name>");
    expect(prompt).toContain("<location>/tmp/x/skills/curl-timeout-guard/SKILL.md</location>");
    expect(prompt).toContain("read its SKILL.md at <location>");
    expect(prompt).not.toContain("Always pass");
    expect(prompt).toContain(TASK.prompt);
    expect(composeRuntimePathwayPrompt(TASK, null)).toBe(TASK.prompt);
  });
});

describe("makeRuntimePathwayRunner", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-pathway-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes the arm's SKILL.md into a fresh scratch workspace, passes it to the executor, and cleans up", async () => {
    const seen: Array<{ prompt: string; workspaceDir?: string; skillOnDisk: string | null }> = [];
    const runner = makeRuntimePathwayRunner({
      agentTurn: async (prompt, opts) => {
        const location = path.join(
          opts?.workspaceDir ?? "",
          "skills",
          "curl-timeout-guard",
          "SKILL.md",
        );
        const skillOnDisk = await fs.readFile(location, "utf-8").catch(() => null);
        seen.push({ prompt, workspaceDir: opts?.workspaceDir, skillOnDisk });
        return { text: "FINAL: hi", runId: "r1" };
      },
      candidate: { name: "curl-timeout-guard", content: SKILL },
      incumbent: null,
      proposalId: "curl-timeout-guard-abc",
      storeOpts: { configDir: tmpDir },
    });
    const candidate = await runner(TASK, "candidate", { trialIndex: 0 });
    const incumbent = await runner(TASK, "incumbent", { trialIndex: 0 });
    expect(typeof candidate === "string" ? candidate : candidate.answer).toBe("FINAL: hi");
    expect(seen[0]?.workspaceDir).toContain(
      path.join(trialsRoot({ configDir: tmpDir }), "curl-timeout-guard-abc"),
    );
    expect(seen[0]?.skillOnDisk).toBe(SKILL);
    expect(seen[0]?.prompt).toContain("<name>curl-timeout-guard</name>");
    expect(seen[0]?.prompt).not.toContain("Always pass");
    // The incumbent arm of a create runs with no skill at all.
    expect(seen[1]?.skillOnDisk).toBeNull();
    expect(seen[1]?.prompt).toBe(TASK.prompt);
    // Scratch dirs are gone after scoring.
    const left = await fs.readdir(trialsRoot({ configDir: tmpDir })).catch(() => []);
    for (const d of left) {
      const inner = await fs
        .readdir(path.join(trialsRoot({ configDir: tmpDir }), d))
        .catch(() => []);
      expect(inner).toEqual([]);
    }
    // No journal: reads are unobservable, not "false".
    expect(typeof incumbent === "string" ? null : incumbent.skillRead).toBeNull();
    expect(typeof candidate === "string" ? null : candidate.skillRead).toBeNull();
  });

  it("reports skillRead from the journal (a read tool call naming the location)", async () => {
    const journal = makeFixtureJournal();
    let location = "";
    const runner = makeRuntimePathwayRunner({
      agentTurn: async (_prompt, opts) => {
        location = path.join(opts?.workspaceDir ?? "", "skills", "curl-timeout-guard", "SKILL.md");
        journal.append({
          runId: "run-read",
          seq: 1,
          stream: "tool",
          ts: 1,
          data: { phase: "start", name: "read", toolCallId: "c1", args: { path: location } },
        });
        journal.append({
          runId: "run-noread",
          seq: 1,
          stream: "tool",
          ts: 2,
          data: { phase: "start", name: "exec", toolCallId: "c2", args: { command: "echo hi" } },
        });
        return { text: "FINAL: hi", runId: "run-read" };
      },
      journal,
      candidate: { name: "curl-timeout-guard", content: SKILL },
      incumbent: null,
      proposalId: "p",
      storeOpts: { configDir: tmpDir },
    });
    const r = await runner(TASK, "candidate", { trialIndex: 0 });
    expect(typeof r === "string" ? null : r.skillRead).toBe(true);
    expect(detectSkillRead(journal, "run-noread", location)).toBe(false);
    expect(detectSkillRead(journal, "run-missing", location)).toBeNull();
  });
});

describe("makeGatewayAgentTurn", () => {
  it("passes the scratch workspace, returns runId + usage, and rejects non-ok", async () => {
    const calls: unknown[] = [];
    const turn = makeGatewayAgentTurn({
      callGateway: async (args) => {
        calls.push(args.params);
        return {
          status: "ok",
          runId: "idem-1",
          result: {
            payloads: [{ text: "FINAL: 42" }],
            meta: { agentMeta: { usage: { input: 100, output: 20 } } },
          },
        };
      },
      agentId: "main",
      channel: "internal",
      makeSessionKey: () => "agent:main:skill-evolve-val-x",
      makeIdempotencyKey: () => "idem-1",
    });
    const r = await turn("prompt", { workspaceDir: "/tmp/w" });
    expect(r).toEqual({ text: "FINAL: 42", runId: "idem-1", usage: { input: 100, output: 20 } });
    expect((calls[0] as { workspaceDir?: string }).workspaceDir).toBe("/tmp/w");
    expect((calls[0] as { idempotencyKey?: string }).idempotencyKey).toBe("idem-1");
    const bad = makeGatewayAgentTurn({
      callGateway: async () => ({ status: "error" }),
      agentId: "main",
      channel: "internal",
      makeSessionKey: () => "k",
      makeIdempotencyKey: () => "i",
    });
    await expect(bad("p")).rejects.toThrow(/status "error"/);
  });
});
