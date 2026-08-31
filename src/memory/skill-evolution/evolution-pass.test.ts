import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { runEvolutionIteration } from "./evolution-pass.js";
import { isRunHeldOut, readSamplerCursor } from "./sampler.js";
import { readIndex, readPattern } from "./wiki-store.js";

/** Non-held-out run ids for fixtures. */
function trainRunIds(count: number, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count && i < 10_000; i++) {
    const id = `${prefix}-${i}`;
    if (!isRunHeldOut(id)) {
      out.push(id);
    }
  }
  return out;
}

const MAINTAINER_JSON = JSON.stringify({
  create_patterns: [
    {
      name: "exec-network-timeout",
      content:
        "# exec network timeout\nRoot cause: curl without --max-time hangs.\nFix: always pass --max-time 30.",
    },
  ],
  update_patterns: [],
  update_index:
    "- [exec-network-timeout](patterns/exec-network-timeout.md): exec curl hangs; no timeout flag; add --max-time.",
  append_log: "Found recurring exec timeout across failing traces.",
});

describe("runEvolutionIteration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evo-pass-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function seedJournal() {
    const journal = makeFixtureJournal();
    for (const id of trainRunIds(3, "f")) {
      appendFixtureRun(journal, {
        runId: id,
        steps: [
          { kind: "tool", name: "exec", args: { cmd: "curl x" }, result: "timeout", isError: true },
        ],
        terminal: "error",
      });
    }
    for (const id of trainRunIds(2, "p")) {
      appendFixtureRun(journal, {
        runId: id,
        steps: [{ kind: "tool", name: "read", result: "ok" }],
        completedExplicitly: true,
      });
    }
    return journal;
  }

  it("runs the full maintainer path: samples, consolidates, writes the wiki, advances the cursor", async () => {
    const journal = seedJournal();
    const prompts: string[] = [];
    const result = await runEvolutionIteration({
      journal,
      llmCall: async (prompt) => {
        prompts.push(prompt);
        return "```json\n" + MAINTAINER_JSON + "\n```";
      },
      storeOpts: { configDir: tmpDir },
    });
    expect(result.ran).toBe(true);
    expect(result.maintenance?.applied).toBe(true);
    expect(result.maintenance?.apply?.created).toEqual(["exec-network-timeout"]);
    expect(await readPattern("exec-network-timeout", { configDir: tmpDir })).toContain(
      "--max-time",
    );
    expect(await readIndex({ configDir: tmpDir })).toContain("exec-network-timeout");
    expect(await readSamplerCursor({ configDir: tmpDir })).toBe(result.cursorAfter);
    expect(result.cursorAfter).toBeGreaterThan(0);
    // The maintainer prompt carried the trace logs and the wiki rules.
    const maintainerPrompt = prompts.find((p) => p.includes("Wiki Maintainer Agent"));
    expect(maintainerPrompt).toBeDefined();
    expect(maintainerPrompt).toContain("labeled FAIL");
    expect(maintainerPrompt).toContain("labeled PASS");
  });

  it("no-ops cleanly without an LLM (keyless installs) or journal", async () => {
    expect(await runEvolutionIteration({ journal: null, llmCall: async () => "" })).toMatchObject({
      ran: false,
      reason: "no-journal",
    });
    expect(await runEvolutionIteration({ journal: seedJournal(), llmCall: null })).toMatchObject({
      ran: false,
      reason: "no-llm",
    });
  });

  it("spends nothing and reports no-new-traces on an exhausted window", async () => {
    const journal = seedJournal();
    const first = await runEvolutionIteration({
      journal,
      llmCall: async () => "```json\n" + MAINTAINER_JSON + "\n```",
      storeOpts: { configDir: tmpDir },
    });
    let llmCalls = 0;
    const second = await runEvolutionIteration({
      journal,
      llmCall: async () => {
        llmCalls += 1;
        return "";
      },
      storeOpts: { configDir: tmpDir },
    });
    expect(first.ran).toBe(true);
    expect(second).toMatchObject({ ran: false, reason: "no-new-traces" });
    expect(llmCalls).toBe(0);
  });

  it("keeps the cursor on unparseable maintainer output so the window retries", async () => {
    const journal = seedJournal();
    const result = await runEvolutionIteration({
      journal,
      llmCall: async () => "sorry, I got confused and wrote prose instead",
      storeOpts: { configDir: tmpDir },
    });
    expect(result).toMatchObject({ ran: true, reason: "maintainer-parse-failed" });
    expect(await readSamplerCursor({ configDir: tmpDir })).toBe(0);
    expect(await readIndex({ configDir: tmpDir })).toBe("");
  });

  it("never throws even when everything is broken", async () => {
    const journal = seedJournal();
    const result = await runEvolutionIteration({
      journal,
      llmCall: async () => {
        throw new Error("provider exploded");
      },
      storeOpts: { configDir: tmpDir },
    });
    expect(result.ran).toBe(false);
  });
});
