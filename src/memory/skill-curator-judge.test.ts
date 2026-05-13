import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TransitionProposal } from "./skill-curator-heuristics.js";
import type { SkillLifecycleRow } from "./skill-lifecycle.js";
import {
  applyPatchDecision,
  buildJudgePrompt,
  judgeBorderline,
  type LlmCall,
  parseJudgeResponse,
  parseSkillMarkdown,
  readSkillMarkdownFromRoots,
  stringifySkillMarkdown,
} from "./skill-curator-judge.js";

const borderline: TransitionProposal = {
  skillName: "flaky-skill",
  fromState: "active",
  toState: null,
  kind: "flag-for-llm",
  reason: "error rate 70% over 20 runs ≥ 50% flag floor",
};

const lifecycle: SkillLifecycleRow = {
  skillName: "flaky-skill",
  origin: "agent_authored",
  state: "active",
  createdAt: 1_700_000_000_000,
  lastUsedAt: 1_800_000_000_000,
  usageCount: 20,
  successCount: 6,
  errorCount: 14,
  consolidatedInto: null,
  pinned: false,
  updatedAt: 1_800_000_000_000,
};

describe("buildJudgePrompt", () => {
  it("includes telemetry, body, peer list, and the four decision options", () => {
    const prompt = buildJudgePrompt({
      borderline,
      lifecycle,
      skillMarkdown: "---\nname: flaky-skill\ndescription: example\n---\nbody here",
      peerSkills: [
        { name: "alpha", description: "does alpha things" },
        { name: "beta", description: "does beta things" },
      ],
    });
    expect(prompt).toContain("flaky-skill");
    expect(prompt).toContain("30.0%"); // 6/20 success rate
    expect(prompt).toContain("does alpha things");
    expect(prompt).toContain("action: keep");
    expect(prompt).toContain("action: archive");
    expect(prompt).toContain("action: consolidate");
    expect(prompt).toContain("action: patch");
  });

  it("truncates long skill bodies", () => {
    const longBody = "x".repeat(10_000);
    const prompt = buildJudgePrompt({
      borderline,
      lifecycle,
      skillMarkdown: longBody,
      peerSkills: [],
    });
    expect(prompt).toContain("…truncated…");
  });

  it("caps peer list size", () => {
    const peers = Array.from({ length: 100 }, (_, i) => ({
      name: `s-${i}`,
      description: `desc-${i}`,
    }));
    const prompt = buildJudgePrompt({
      borderline,
      lifecycle,
      skillMarkdown: "body",
      peerSkills: peers,
    });
    expect(prompt).toContain("s-0:");
    expect(prompt).toContain("s-29:");
    expect(prompt).not.toContain("s-30:");
  });
});

describe("parseJudgeResponse", () => {
  it("parses a keep decision wrapped in a yaml fence", () => {
    const out = parseJudgeResponse('```yaml\naction: keep\nreason: "looks fine"\n```');
    expect(out).toEqual({ action: "keep", reason: "looks fine" });
  });

  it("parses an archive decision in a bare yaml block", () => {
    const out = parseJudgeResponse("action: archive\nreason: broken intent\n");
    expect(out).toEqual({ action: "archive", reason: "broken intent" });
  });

  it("parses a consolidate decision with into", () => {
    const out = parseJudgeResponse(
      '```yaml\naction: consolidate\ninto: "alpha"\nreason: "subsumed by alpha"\n```',
    );
    expect(out).toEqual({ action: "consolidate", into: "alpha", reason: "subsumed by alpha" });
  });

  it("parses a patch decision with new_description", () => {
    const out = parseJudgeResponse(
      '```yaml\naction: patch\nnew_description: "better wording"\nreason: "clearer"\n```',
    );
    expect(out).toEqual({
      action: "patch",
      newDescription: "better wording",
      reason: "clearer",
    });
  });

  it("returns null for unknown actions", () => {
    expect(parseJudgeResponse("action: delete\nreason: x")).toBeNull();
  });

  it("returns null for consolidate without into", () => {
    expect(parseJudgeResponse("action: consolidate\nreason: x")).toBeNull();
  });

  it("returns null for patch without new_description", () => {
    expect(parseJudgeResponse("action: patch\nreason: x")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseJudgeResponse("the model went off the rails")).toBeNull();
    expect(parseJudgeResponse("")).toBeNull();
  });

  it("tolerates extra text around the fence", () => {
    const out = parseJudgeResponse(
      'Here is my decision:\n```yaml\naction: keep\nreason: "ok"\n```\nLet me know if you have questions.',
    );
    expect(out).toEqual({ action: "keep", reason: "ok" });
  });
});

describe("judgeBorderline", () => {
  it("returns the parsed decision when the LLM produces valid YAML", async () => {
    const llmCall: LlmCall = async () => '```yaml\naction: archive\nreason: "looks broken"\n```';
    const out = await judgeBorderline(
      { borderline, lifecycle, skillMarkdown: "---\nname: x\n---", peerSkills: [] },
      llmCall,
    );
    expect(out.decision).toEqual({ action: "archive", reason: "looks broken" });
  });

  it("returns null decision with rawOnFailure when output is unparseable", async () => {
    const llmCall: LlmCall = async () => "I cannot decide.";
    const out = await judgeBorderline(
      { borderline, lifecycle, skillMarkdown: "---\nname: x\n---", peerSkills: [] },
      llmCall,
    );
    expect(out.decision).toBeNull();
    expect(out.rawOnFailure).toContain("cannot decide");
  });

  it("returns null decision when the LLM throws", async () => {
    const llmCall: LlmCall = async () => {
      throw new Error("backend exploded");
    };
    const out = await judgeBorderline(
      { borderline, lifecycle, skillMarkdown: "---\nname: x\n---", peerSkills: [] },
      llmCall,
    );
    expect(out.decision).toBeNull();
    expect(out.rawOnFailure).toBeUndefined();
  });
});

describe("parseSkillMarkdown / stringifySkillMarkdown", () => {
  it("round-trips a basic skill", () => {
    const text = "---\nname: alpha\ndescription: hello world\n---\nbody content\n";
    const parsed = parseSkillMarkdown(text);
    if (!parsed) throw new Error("expected parse to succeed");
    expect(parsed.frontmatter.name).toBe("alpha");
    expect(parsed.body).toContain("body content");
    const restringified = stringifySkillMarkdown(parsed);
    const reparsed = parseSkillMarkdown(restringified);
    expect(reparsed?.frontmatter.name).toBe("alpha");
    expect(reparsed?.frontmatter.description).toBe("hello world");
  });

  it("returns null without frontmatter", () => {
    expect(parseSkillMarkdown("no frontmatter here")).toBeNull();
  });
});

describe("readSkillMarkdownFromRoots + applyPatchDecision", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-curator-judge-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reads the first matching SKILL.md from the configured roots", async () => {
    const skillDir = path.join(tmp, "alpha");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: alpha\ndescription: hello\n---\nbody\n",
      "utf-8",
    );
    const out = await readSkillMarkdownFromRoots({
      skillName: "alpha",
      roots: [tmp],
    });
    expect(out).not.toBeNull();
    expect(out?.content).toContain("hello");
  });

  it("returns null when SKILL.md is absent from every root", async () => {
    const out = await readSkillMarkdownFromRoots({
      skillName: "missing",
      roots: [tmp],
    });
    expect(out).toBeNull();
  });

  it("applyPatchDecision rewrites only the description and preserves the body", async () => {
    const skillDir = path.join(tmp, "alpha");
    await fs.mkdir(skillDir, { recursive: true });
    const file = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      file,
      "---\nname: alpha\ndescription: original\nrequires:\n  bins:\n    - git\n---\nbody1\nbody2\n",
      "utf-8",
    );
    const ok = await applyPatchDecision({ filePath: file, newDescription: "updated wording" });
    expect(ok).toBe(true);
    const after = await fs.readFile(file, "utf-8");
    const parsed = parseSkillMarkdown(after);
    expect(parsed?.frontmatter.description).toBe("updated wording");
    expect(parsed?.frontmatter.name).toBe("alpha");
    expect(after).toContain("body1");
    expect(after).toContain("body2");
  });

  it("applyPatchDecision returns false on bad frontmatter", async () => {
    const file = path.join(tmp, "broken.md");
    await fs.writeFile(file, "no frontmatter here", "utf-8");
    const ok = await applyPatchDecision({ filePath: file, newDescription: "x" });
    expect(ok).toBe(false);
  });
});
