import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  applyCanaryExposure,
  canaryUnit,
  inCanaryBucket,
  readCanaryRegistry,
  readCanaryRegistrySync,
  registerCanary,
  resetCanaryRegistryCacheForTest,
  resolveCanaryExposure,
  skillNamesInPrompt,
  stripSkillsFromPrompt,
  unregisterCanary,
} from "./canary-registry.js";

const PROMPT = [
  "The following skills provide specialized instructions for specific tasks.",
  "",
  "<available_skills>",
  "  <skill>",
  "    <name>curl-timeout-guard</name>",
  "    <description>Use when running curl against flaky hosts</description>",
  "    <location>/x/skills/curl-timeout-guard/SKILL.md</location>",
  "  </skill>",
  "  <skill>",
  "    <name>git-not-a-repo</name>",
  "    <description>Use when git says not a repository</description>",
  "    <location>/x/skills/git-not-a-repo/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

describe("canary registry (PLAN-45 Phase 3.2)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "canary-reg-"));
    resetCanaryRegistryCacheForTest();
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    resetCanaryRegistryCacheForTest();
  });

  it("buckets deterministically at the requested fraction", () => {
    const a = inCanaryBucket("run-1", "s", 0.5, "seed");
    expect(inCanaryBucket("run-1", "s", 0.5, "seed")).toBe(a);
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      if (inCanaryBucket(`run-${i}`, "s", 0.5, "seed")) {
        hits += 1;
      }
    }
    expect(hits).toBeGreaterThan(850);
    expect(hits).toBeLessThan(1150);
    expect(inCanaryBucket("run-1", "s", 0, "seed")).toBe(false);
    expect(inCanaryBucket("run-1", "s", 1, "seed")).toBe(true);
    // Different skills / seeds split independently.
    let same = 0;
    for (let i = 0; i < 2000; i++) {
      if (
        inCanaryBucket(`run-${i}`, "a", 0.5, "seed") ===
        inCanaryBucket(`run-${i}`, "b", 0.5, "seed")
      ) {
        same += 1;
      }
    }
    expect(same).toBeGreaterThan(850);
    expect(same).toBeLessThan(1150);
  });

  it("randomizes per session-day: one bucket for a session within a day, a keyless run on its own", () => {
    const day1 = Date.UTC(2026, 8, 6, 10);
    expect(canaryUnit({ runId: "r1", sessionKey: "agent:main:main", now: day1 })).toBe(
      canaryUnit({ runId: "r2", sessionKey: "agent:main:main", now: day1 + 3600_000 }),
    );
    expect(canaryUnit({ runId: "r1", sessionKey: "agent:main:main", now: day1 })).not.toBe(
      canaryUnit({ runId: "r1", sessionKey: "agent:main:main", now: day1 + 24 * 3600_000 }),
    );
    expect(canaryUnit({ runId: "r1", now: day1 })).toBe("r1|2026-09-06");
    // Over many days one session lands in both cohorts.
    let exposed = 0;
    for (let d = 0; d < 400; d++) {
      const unit = canaryUnit({
        runId: "x",
        sessionKey: "agent:main:main",
        now: day1 + d * 86_400_000,
      });
      if (inCanaryBucket(unit, "s", 0.5, "seed")) exposed += 1;
    }
    expect(exposed).toBeGreaterThan(150);
    expect(exposed).toBeLessThan(250);
  });

  it("strips exactly the withheld <skill> blocks and leaves the rest byte-identical", () => {
    expect([...skillNamesInPrompt(PROMPT)]).toEqual(["curl-timeout-guard", "git-not-a-repo"]);
    const out = stripSkillsFromPrompt(PROMPT, new Set(["curl-timeout-guard"]));
    expect(out).not.toContain("curl-timeout-guard");
    expect(out).toContain("<name>git-not-a-repo</name>");
    expect(out).toContain("<available_skills>");
    expect(out).toContain("</available_skills>");
    expect(stripSkillsFromPrompt(PROMPT, new Set())).toBe(PROMPT);
    expect(stripSkillsFromPrompt(PROMPT, new Set(["absent"]))).toBe(PROMPT);
  });

  it("persists entries, invalidates the sync cache on write, and drops malformed entries", async () => {
    expect(readCanaryRegistrySync({ configDir: tmp }).skills).toEqual({});
    await registerCanary(
      "curl-timeout-guard",
      { startedAt: 1000, bucketFraction: 0.5, descriptionAtStart: "curl flaky", reason: "gate" },
      { configDir: tmp },
    );
    const sync = readCanaryRegistrySync({ configDir: tmp });
    expect(sync.skills["curl-timeout-guard"]).toMatchObject({ startedAt: 1000, reason: "gate" });
    expect(typeof sync.skills["curl-timeout-guard"]?.seed).toBe("string");
    // Cached: same object until the file changes.
    expect(readCanaryRegistrySync({ configDir: tmp })).toBe(sync);
    await unregisterCanary("curl-timeout-guard", { configDir: tmp });
    expect(readCanaryRegistrySync({ configDir: tmp }).skills).toEqual({});
    await fs.writeFile(
      path.join(tmp, "skill-wiki", "canary.json"),
      JSON.stringify({ version: 1, skills: { bad: { startedAt: "x" }, ok: { startedAt: 5 } } }),
    );
    const parsed = await readCanaryRegistry({ configDir: tmp });
    expect(Object.keys(parsed.skills)).toEqual(["ok"]);
    expect(parsed.skills.ok?.bucketFraction).toBe(0.5);
  });

  it("resolveCanaryExposure ignores canaries absent from the run's index", () => {
    const registry = {
      version: 1 as const,
      skills: {
        a: {
          startedAt: 1,
          bucketFraction: 1,
          descriptionAtStart: "",
          reason: "gate" as const,
          seed: "s",
        },
        b: {
          startedAt: 1,
          bucketFraction: 0,
          descriptionAtStart: "",
          reason: "gate" as const,
          seed: "s",
        },
        c: {
          startedAt: 1,
          bucketFraction: 1,
          descriptionAtStart: "",
          reason: "gate" as const,
          seed: "s",
        },
      },
    };
    expect(resolveCanaryExposure({ unit: "r", registry, indexNames: new Set(["a", "b"]) })).toEqual(
      { exposed: ["a"], withheld: ["b"] },
    );
  });

  it("applyCanaryExposure filters the prompt, journals the exposure once per run, and bypasses validation sessions", async () => {
    const seen: Array<{ runId: string; data: Record<string, unknown> }> = [];
    const off = onAgentEvent((e) => {
      if (e.stream === "skills") {
        seen.push({ runId: e.runId, data: e.data });
      }
    });
    try {
      // No registry: byte-identical prompt, no event.
      expect(
        applyCanaryExposure({ prompt: PROMPT, runId: "r0", storeOpts: { configDir: tmp } }),
      ).toBe(PROMPT);
      expect(seen).toEqual([]);
      await registerCanary(
        "curl-timeout-guard",
        { startedAt: 1, bucketFraction: 0, descriptionAtStart: "", reason: "gate" },
        { configDir: tmp },
      );
      const out = applyCanaryExposure({
        prompt: PROMPT,
        runId: "r1",
        sessionKey: "agent:main:main",
        storeOpts: { configDir: tmp },
      });
      expect(out).not.toContain("curl-timeout-guard");
      expect(out).toContain("git-not-a-repo");
      expect(seen).toEqual([
        { runId: "r1", data: { exposed: [], withheld: ["curl-timeout-guard"] } },
      ]);
      // Second call for the same run (retry): filtered again, no second event.
      applyCanaryExposure({ prompt: PROMPT, runId: "r1", storeOpts: { configDir: tmp } });
      expect(seen).toHaveLength(1);
      // Validation rollouts must see the candidate.
      expect(
        applyCanaryExposure({
          prompt: PROMPT,
          runId: "r2",
          bypass: true,
          storeOpts: { configDir: tmp },
        }),
      ).toBe(PROMPT);
      expect(seen).toHaveLength(1);
    } finally {
      off();
    }
  });
});
