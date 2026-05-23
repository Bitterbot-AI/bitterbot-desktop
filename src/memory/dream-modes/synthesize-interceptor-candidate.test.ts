import { describe, expect, it } from "vitest";
import {
  renderSkillMd,
  synthesizeInterceptorCandidate,
  __testing,
} from "./synthesize-interceptor-candidate.js";

describe("synthesize-interceptor-candidate", () => {
  it("validateCandidate accepts a well-formed spec", () => {
    const v = __testing.validateCandidate({
      id: "foo:default",
      skill: "foo",
      priority: 70,
      tools: ["send_message"],
      maxFiresPerEpisode: 3,
      activation: { description: "when X happens", conditions: ["X happens"] },
      intervention: { type: "modify", description: "rewrites Y", reason: "to fix Z" },
      rationale: "fixes a recurring competence gap",
    });
    expect(v.ok).toBe(true);
  });

  it("validateCandidate rejects invalid id", () => {
    const v = __testing.validateCandidate({
      id: "BadID",
      skill: "foo",
      priority: 70,
      tools: ["t"],
      maxFiresPerEpisode: 3,
      activation: { description: "x", conditions: [] },
      intervention: { type: "noop", description: "", reason: "abcdefgh" },
      rationale: "lorem ipsum",
    } as unknown as never);
    expect(v.ok).toBe(false);
  });

  it("validateCandidate rejects when type require_prereq lacks prereqTool", () => {
    const v = __testing.validateCandidate({
      id: "foo:default",
      skill: "foo",
      priority: 70,
      tools: ["t"],
      maxFiresPerEpisode: 3,
      activation: { description: "x", conditions: [] },
      intervention: { type: "require_prereq", description: "", reason: "abcdefgh" },
      rationale: "lorem ipsum",
    } as unknown as never);
    expect(v.ok).toBe(false);
  });

  it("tryParseJson strips ```json fences", () => {
    const obj = __testing.tryParseJson('```json\n{"a": 1}\n```');
    expect(obj).toEqual({ a: 1 });
  });

  it("renderSkillMd produces a parseable SKILL.md", () => {
    const body = renderSkillMd({
      id: "foo:default",
      skill: "foo",
      priority: 70,
      tools: ["send_message"],
      maxFiresPerEpisode: 3,
      activation: { description: "when X", conditions: ["c1", "c2"] },
      intervention: { type: "modify", description: "rewrites Y", reason: "to fix Z" },
      rationale: "fixes a thing",
    });
    expect(body).toContain("---");
    expect(body).toContain("name: foo");
    expect(body).toContain("tier: executable");
    expect(body).toContain("intervention: modify");
  });

  it("synthesizeInterceptorCandidate returns failure when LLM returns garbage", async () => {
    const result = await synthesizeInterceptorCandidate({
      llmCall: async () => "not json",
      cluster: {
        toolName: "t",
        channel: "internal",
        shape: "t::a,b",
        cohortSize: 5,
        failureRate: 0.6,
        sampleParams: [{ a: 1 }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it("synthesizeInterceptorCandidate returns success on well-formed JSON", async () => {
    const json = JSON.stringify({
      id: "foo:default",
      skill: "foo",
      priority: 70,
      tools: ["t"],
      maxFiresPerEpisode: 3,
      activation: { description: "when X", conditions: [] },
      intervention: { type: "modify", description: "rewrite", reason: "fix it now" },
      rationale: "fixes the cluster",
    });
    const result = await synthesizeInterceptorCandidate({
      llmCall: async () => json,
      cluster: {
        toolName: "t",
        channel: "internal",
        shape: "t::a,b",
        cohortSize: 5,
        failureRate: 0.6,
        sampleParams: [{ a: 1 }],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.skill).toBe("foo");
  });
});
