/**
 * DEMO (not a regression test): drive ONE full WikiSkill evolution iteration
 * end-to-end in tasks-mode against a temp workspace, printing every artifact
 * the pipeline produces so we can watch experience -> wiki -> skill -> gate.
 *
 * Signals are mocked (maintainer JSON, proposer JSON, agent rollout pass/fail)
 * so the run is deterministic and offline. Run with:
 *   npx vitest run src/memory/skill-evolution/demo-e2e.wikiskill.test.ts --config vitest.unit.config.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { runEvolutionIteration } from "./evolution-pass.js";
import { isRunHeldOut } from "./sampler.js";
import { readIndex, readPattern, listPatternNames, logsPath } from "./wiki-store.js";

function nonHeldOut(count: number, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count && i < 10_000; i++) {
    const id = `${prefix}-${i}`;
    if (!isRunHeldOut(id)) out.push(id);
  }
  return out;
}

// The Wiki Maintainer's mocked consolidation: one failure pattern from the
// recurring curl-timeout traces below.
const MAINTAINER_JSON = JSON.stringify({
  create_patterns: [
    {
      name: "exec-curl-no-timeout",
      content:
        "# exec curl without timeout\n" +
        "PROBLEM: `curl <url>` in exec hangs indefinitely on a stalled connection.\n" +
        "ROOT CAUSE: no connect/transfer bound, so a dead socket blocks the whole turn.\n" +
        "FIX: always pass `--max-time 30 --connect-timeout 10`.\n" +
        "Evidence: failing traces f-0/f-1/f-2 all issued bare `curl x` and terminated in error.",
    },
  ],
  update_patterns: [],
  update_index:
    "- [exec-curl-no-timeout](patterns/exec-curl-no-timeout.md): bare curl in exec hangs; " +
    "no timeout bound; add --max-time 30 --connect-timeout 10.",
  append_log: "Iter demo: consolidated recurring exec curl-timeout failure into one pattern.",
});

// The Skill Proposer's mocked proposal: create a skill motivated by the wiki
// pattern, with PURPOSE.md linking back to it (paper §3.1).
const PROPOSER_FINISH = JSON.stringify({
  tool: "finish",
  proposal: {
    action: "create",
    name: "curl-timeout-guard",
    skill_md:
      "---\nname: curl-timeout-guard\n" +
      "description: Bound every curl in exec with --max-time; apply when running curl.\n---\n\n" +
      "## When to Apply\nAny exec call invoking curl.\n\n" +
      "## Rule\nAlways pass `--max-time 30 --connect-timeout 10`.\n",
    purpose_md:
      "# Purpose\n\n## Origin\nwiki-evolution\n\n## Patterns Addressed\n- exec-curl-no-timeout\n\n" +
      "## Evolution History\nCreated from demo iteration.\n",
    reason: "Recurring exec-curl-no-timeout failures across the window justify a guarding skill.",
  },
});

describe("WikiSkill end-to-end demo (tasks-mode)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wikiskill-demo-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("experience -> wiki pattern -> staged skill -> validation gate, all artifacts printed", async () => {
    // 1) RAW LAYER: seed the journal with recurring failures + some successes.
    const journal = makeFixtureJournal();
    for (const id of nonHeldOut(3, "f")) {
      appendFixtureRun(journal, {
        runId: id,
        steps: [
          { kind: "tool", name: "exec", args: { cmd: "curl x" }, result: "timeout", isError: true },
        ],
        terminal: "error",
      });
    }
    for (const id of nonHeldOut(2, "p")) {
      appendFixtureRun(journal, {
        runId: id,
        steps: [{ kind: "tool", name: "read", result: "ok" }],
        completedExplicitly: true,
      });
    }

    // Router: maintainer vs proposer vs trace-labeler by prompt content.
    const llmCall = async (prompt: string): Promise<string> => {
      if (prompt.includes("Skill Proposer")) return PROPOSER_FINISH;
      if (prompt.includes("Wiki Maintainer")) return "```json\n" + MAINTAINER_JSON + "\n```";
      // Trace labeler / anything else: label failing traces as fail.
      return JSON.stringify({ label: "fail", reason: "exec error" });
    };

    // TASKS-MODE agent rollout: the candidate skill (with --max-time) passes;
    // the incumbent (none) fails. This is the ground-truth signal the gate
    // runs its paired sign test over.
    const agentTurn = async (args: { systemAppend?: string }): Promise<string> => {
      const hasGuard = (args.systemAppend ?? "").includes("--max-time");
      return hasGuard ? "DONE: curl --max-time 30 succeeded" : "FAIL: curl hung";
    };

    console.log("\n======== WIKISKILL E2E DEMO ========");
    console.log("workspace:", tmpDir);

    const result = await runEvolutionIteration({
      journal,
      llmCall,
      agentTurn,
      validationMode: "tasks",
      trialsPerTask: 3,
      propagate: false, // don't touch the P2P publish leg in the demo
      storeOpts: { configDir: tmpDir },
      cycleId: "demo-iter-1",
    });

    // ---- Print the pipeline result ----
    console.log("\n--- [1] PASS RESULT ---");
    console.log("ran:", result.ran, "reason:", result.reason ?? "(none)");
    console.log("samples:", JSON.stringify(result.samplerStats));
    console.log(
      "maintenance.applied:",
      result.maintenance?.applied,
      "created:",
      result.maintenance?.apply?.created,
    );
    console.log("proposer:", result.proposer?.proposal.action, "turns:", result.proposer?.turns);
    console.log("proposalOutcome:", JSON.stringify(result.proposalOutcome));
    console.log("validation:", JSON.stringify(result.validation, null, 2));

    // ---- [2] WIKI LAYER artifacts ----
    console.log("\n--- [2] WIKI LAYER (patterns/, index.md, logs.md) ---");
    console.log("patterns:", await listPatternNames({ configDir: tmpDir }));
    console.log("\nindex.md:\n" + (await readIndex({ configDir: tmpDir })));
    console.log(
      "\npatterns/exec-curl-no-timeout.md:\n" +
        (await readPattern("exec-curl-no-timeout", { configDir: tmpDir })),
    );
    try {
      console.log("\nlogs.md:\n" + (await fs.readFile(logsPath({ configDir: tmpDir }), "utf-8")));
    } catch {
      /* ignore */
    }

    // ---- [3] SKILL + IMPACT artifacts ----
    console.log("\n--- [3] SKILL LAYER + IMPACT TRAIL ---");
    const walk = async (root: string, label: string) => {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        console.log(
          `${label} (${root}):`,
          entries.map((e) => e.name),
        );
      } catch {
        console.log(`${label}: (none)`);
      }
    };
    await walk(path.join(tmpDir, "skills"), "live skills");
    await walk(path.join(tmpDir, "skills-staging"), "staged skills");
    try {
      const impact = await fs.readFile(path.join(tmpDir, "skill-wiki", "skill-impact.md"), "utf-8");
      console.log("\nskill-impact.md:\n" + impact);
    } catch {
      console.log("skill-impact.md: (none yet)");
    }
    console.log("======== END DEMO ========\n");

    // Minimal assertions so the demo also proves correctness.
    expect(result.ran).toBe(true);
    expect(result.maintenance?.apply?.created).toContain("exec-curl-no-timeout");
    expect(await readPattern("exec-curl-no-timeout", { configDir: tmpDir })).toContain(
      "--max-time",
    );
  }, 60_000);
});
