import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCanary } from "../../agents/skills/canary-registry.js";
import { liveSkillPath, resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { appendCanaryRuns, isEligibleTask, readCanaryRuns } from "./canary-ledger.js";
import { creditSkillReads } from "./skill-reads.js";

describe("canary ledger (PLAN-45 Phase 3.2)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "canary-ledger-"));
    const roots = resolveStorageRoots({ configDir: tmp });
    await fs.mkdir(path.dirname(liveSkillPath(roots, "curl-timeout-guard")), { recursive: true });
    await fs.writeFile(
      liveSkillPath(roots, "curl-timeout-guard"),
      "---\nname: curl-timeout-guard\ndescription: d\n---\nbody\n",
    );
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("eligibility: positive clause of the description against the task header", () => {
    const desc = "Use when running curl against flaky hosts that time out; not for local files";
    expect(
      isEligibleTask(desc, "please run curl against the flaky host, it keeps timing out"),
    ).toBe(true);
    expect(isEligibleTask(desc, "rename these local files")).toBe(false);
    expect(isEligibleTask(desc, null)).toBe(false);
    expect(isEligibleTask("", "anything")).toBe(false);
  });

  it("round-trips rows and skips malformed lines", async () => {
    await appendCanaryRuns(
      [
        {
          runId: "r",
          skill: "s",
          ts: 1,
          exposed: true,
          read: true,
          eligible: true,
          label: "pass",
          outcomeLevel: 2,
          model: null,
          origin: "human",
          credited: true,
          sessionKey: null,
        },
      ],
      { configDir: tmp },
    );
    await fs.appendFile(path.join(tmp, "skill-wiki", "canary-runs.jsonl"), "{bad\n{}\n");
    const rows = await readCanaryRuns({ configDir: tmp });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: "r", read: true });
  });

  it("creditSkillReads writes one row per (run, canary): exposed+read, exposed+unread, withheld; idempotent; closed windows skipped", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const live = liveSkillPath(roots, "curl-timeout-guard");
    await registerCanary(
      "curl-timeout-guard",
      {
        startedAt: 1,
        bucketFraction: 0.5,
        descriptionAtStart: "Use when running curl against flaky hosts that time out",
        reason: "gate",
      },
      { configDir: tmp },
    );
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "exposed-read",
      task: { text: "run curl against the flaky host that times out" },
      exposure: { exposed: ["curl-timeout-guard"], withheld: [] },
      steps: [{ kind: "tool", name: "read", args: { path: live } }],
      completedExplicitly: true,
      model: { provider: "openai", model: "x" },
    });
    appendFixtureRun(journal, {
      runId: "exposed-unread",
      task: { text: "run curl against the flaky host that times out" },
      exposure: { exposed: ["curl-timeout-guard"], withheld: [] },
      steps: [{ kind: "tool", name: "exec", args: { command: "curl x" } }],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "withheld-eligible",
      task: { text: "run curl against the flaky host that times out" },
      exposure: { exposed: [], withheld: ["curl-timeout-guard"] },
      steps: [{ kind: "tool", name: "exec", args: { command: "curl x" } }],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "withheld-irrelevant",
      task: { text: "rename the photos" },
      exposure: { exposed: [], withheld: ["curl-timeout-guard"] },
      steps: [{ kind: "tool", name: "exec", args: { command: "mv a b" } }],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "closed-window",
      task: { text: "run curl against the flaky host" },
      exposure: { exposed: [], withheld: ["graduated-skill"] },
      steps: [{ kind: "tool", name: "exec", args: { command: "curl x" } }],
      completedExplicitly: true,
    });
    const r = await creditSkillReads({ journal, storeOpts: { configDir: tmp } });
    expect(r.credited).toBe(1);
    expect(r.canaryRows).toBe(4);
    const rows = await readCanaryRuns({ configDir: tmp });
    expect(rows.map((x) => [x.runId, x.exposed, x.read, x.eligible, x.label, x.model])).toEqual([
      ["exposed-read", true, true, true, "pass", "openai/x"],
      ["exposed-unread", true, false, true, "pass", null],
      ["withheld-eligible", false, false, true, "pass", null],
      ["withheld-irrelevant", false, false, false, "pass", null],
    ]);
    const again = await creditSkillReads({ journal, storeOpts: { configDir: tmp } });
    expect(again.canaryRows).toBe(0);
    expect(await readCanaryRuns({ configDir: tmp })).toHaveLength(4);
  });
});
