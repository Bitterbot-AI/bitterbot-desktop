import { describe, expect, it } from "vitest";
import { skillNamesInPrompt } from "./skills/canary-registry.js";
import {
  buildSkillsSection,
  compactSkillsPrompt,
  summarizeSkillLine,
} from "./system-prompt-skills.js";

function skill(name: string, description: string): string {
  return [
    "  <skill>",
    `    <name>${name}</name>`,
    `    <description>${description}</description>`,
    `    <location>/skills/${name}/SKILL.md</location>`,
    "  </skill>",
  ].join("\n");
}

function index(blocks: string[]): string {
  return ["Preamble line.", "", "<available_skills>", ...blocks, "</available_skills>"].join("\n");
}

describe("summarizeSkillLine", () => {
  it("keeps the first sentence and collapses whitespace", () => {
    expect(summarizeSkillLine("Use when  the user\n asks for X. Never for Y.", 160)).toBe(
      "Use when the user asks for X.",
    );
  });
  it("cuts long sentences at a word boundary with an ellipsis", () => {
    const out = summarizeSkillLine("a".repeat(30) + " " + "b".repeat(30) + " ccc", 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("compactSkillsPrompt", () => {
  it("renders one line per description and preserves name, location and the XML shape", () => {
    const prompt = index([
      skill("alpha", "Use when asked about alpha.\nSecond paragraph with &amp; entity. Third."),
      skill("beta", "Use when asked about beta &lt;b&gt;. More."),
    ]);
    const out = compactSkillsPrompt(prompt);
    expect(out).toContain("Preamble line.");
    expect(out).toContain("<description>Use when asked about alpha.</description>");
    expect(out).toContain("<description>Use when asked about beta &lt;b&gt;.</description>");
    expect(out).toContain("<location>/skills/alpha/SKILL.md</location>");
    expect([...skillNamesInPrompt(out)]).toEqual(["alpha", "beta"]);
  });

  it("steps description length down to fit the budget and never drops a skill", () => {
    const blocks = Array.from({ length: 40 }, (_, i) =>
      skill(
        `skill-${i}`,
        `Use when the user asks about topic number ${i} in great and repeated detail, ${"x".repeat(150)}.`,
      ),
    );
    const out = compactSkillsPrompt(index(blocks), 4_000);
    expect(skillNamesInPrompt(out).size).toBe(40);
    // 40 entries cannot fit 4k chars with descriptions: names + locations only.
    expect(out).not.toContain("<description>");
    expect(out.length).toBeLessThan(4_000);
  });

  it("is a no-op without skill blocks", () => {
    expect(compactSkillsPrompt("no skills here")).toBe("no skills here");
  });

  it("is stable: compacting twice yields the same bytes", () => {
    const prompt = index([skill("a", "Use when a. Then b.")]);
    const once = compactSkillsPrompt(prompt);
    expect(compactSkillsPrompt(once)).toBe(once);
  });
});

describe("buildSkillsSection", () => {
  it("wraps the compacted index with the mandatory instructions", () => {
    const lines = buildSkillsSection({
      skillsPrompt: index([skill("demo", "Use when demo. Long tail.")]),
      isMinimal: false,
      readToolName: "Read",
    });
    const text = lines.join("\n");
    expect(text).toContain("## Skills (mandatory)");
    expect(text).toContain("with `Read`");
    expect(text).toContain("<description>Use when demo.</description>");
  });
  it("is empty in minimal mode unless skillsInMinimal", () => {
    const prompt = index([skill("demo", "Use when demo.")]);
    expect(
      buildSkillsSection({ skillsPrompt: prompt, isMinimal: true, readToolName: "read" }),
    ).toEqual([]);
    expect(
      buildSkillsSection({
        skillsPrompt: prompt,
        isMinimal: true,
        readToolName: "read",
        skillsInMinimal: true,
      }).join("\n"),
    ).toContain("<name>demo</name>");
  });
});
