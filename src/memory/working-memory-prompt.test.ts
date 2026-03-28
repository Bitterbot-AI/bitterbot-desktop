import { describe, it, expect } from "vitest";
import {
  buildWorkingMemorySynthesisPrompt,
  buildHeuristicWorkingMemory,
  validateWorkingMemory,
  WORKING_MEMORY_SECTIONS,
  type WorkingMemoryContext,
} from "./working-memory-prompt.js";

function makeContext(overrides?: Partial<WorkingMemoryContext>): WorkingMemoryContext {
  return {
    oldState: "",
    scratchNotes: "",
    recentCrystals: [],
    dreamInsights: [],
    curiosityTargets: [],
    emergingSkills: [],
    hormonalState: { dopamine: 0.5, cortisol: 0.2, oxytocin: 0.4, mood: "motivated" },
    timestamp: "2026-03-12T00:00:00Z",
    ...overrides,
  };
}

describe("working-memory-prompt", () => {
  describe("buildWorkingMemorySynthesisPrompt", () => {
    it("should produce a prompt containing all 7 sections in the template", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(makeContext());
      for (const section of WORKING_MEMORY_SECTIONS) {
        expect(prompt).toContain(`## ${section}`);
      }
    });

    it("should include RLM state update instructions", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(makeContext());
      expect(prompt).toContain("Reinforce");
      expect(prompt).toContain("Update");
      expect(prompt).toContain("Evict");
      expect(prompt).toContain("Consume scratch");
    });

    it("should include hormonal attention weights when state is provided", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(
        makeContext({ hormonalState: { dopamine: 0.8, cortisol: 0.1, oxytocin: 0.6, mood: "energized" } }),
      );
      expect(prompt).toContain("Dopamine (0.80)");
      expect(prompt).toContain("DOMINANT");
      expect(prompt).toContain("Oxytocin (0.60)");
    });

    it("should include scratch notes in the prompt", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(
        makeContext({ scratchNotes: "- [2026-03-12] Vic prefers tabs over spaces" }),
      );
      expect(prompt).toContain("Vic prefers tabs over spaces");
    });

    it("should include recent crystals", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(
        makeContext({
          recentCrystals: [{ text: "User is building a P2P agent system", semanticType: "fact", importanceScore: 0.9 }],
        }),
      );
      expect(prompt).toContain("P2P agent system");
    });

    it("should include dream insights", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(
        makeContext({
          dreamInsights: [{ content: "Cross-domain connection between CORS and EigenTrust", mode: "simulation", confidence: 0.85 }],
        }),
      );
      expect(prompt).toContain("CORS and EigenTrust");
    });

    it("should handle null hormonal state gracefully", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(makeContext({ hormonalState: null }));
      expect(prompt).toContain("Mood: unknown");
      expect(prompt).not.toContain("Hormonal Attention Weights");
    });
  });

  describe("buildHeuristicWorkingMemory", () => {
    it("should produce valid working memory with all 7 sections", () => {
      const result = buildHeuristicWorkingMemory(makeContext());
      const validation = validateWorkingMemory(result);
      expect(validation.valid).toBe(true);
      expect(validation.missing).toEqual([]);
    });

    it("should include scratch notes in active context", () => {
      const result = buildHeuristicWorkingMemory(
        makeContext({ scratchNotes: "- [2026-03-12] Important: deploy by Friday" }),
      );
      expect(result).toContain("Important: deploy by Friday");
    });

    it("should include curiosity targets", () => {
      const result = buildHeuristicWorkingMemory(
        makeContext({
          curiosityTargets: [{ description: "How does the P2P bridge handle NAT traversal?", priority: 0.8 }],
        }),
      );
      expect(result).toContain("NAT traversal");
    });

    it("should include emerging skills", () => {
      const result = buildHeuristicWorkingMemory(
        makeContext({
          emergingSkills: [{ pattern: "TypeScript refactoring", confidence: 0.85, occurrences: 7 }],
        }),
      );
      expect(result).toContain("TypeScript refactoring");
      expect(result).toContain("85%");
      expect(result).toContain("Occurrences: 7");
    });

    it("should preserve The Bond from old state", () => {
      const oldState = `# Working Memory State
## The Bond (Oxytocin-Weighted)
Vic is an architect who values clean code.

## Active Context (Dopamine/Cortisol-Weighted)
Working on memory system.`;

      const result = buildHeuristicWorkingMemory(makeContext({ oldState }));
      expect(result).toContain("Vic is an architect who values clean code");
    });

    it("should include timestamp and mood", () => {
      const result = buildHeuristicWorkingMemory(makeContext());
      expect(result).toContain("2026-03-12T00:00:00Z");
      expect(result).toContain("motivated");
    });
  });

  describe("validateWorkingMemory", () => {
    it("should pass for valid content with all sections", () => {
      const content = WORKING_MEMORY_SECTIONS.map((s) => `## ${s}\nContent`).join("\n\n");
      const result = validateWorkingMemory(content);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it("should fail and report missing sections", () => {
      const content = "## The Bond\nContent\n## Active Context\nContent";
      const result = validateWorkingMemory(content);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("Crystal Pointers");
      expect(result.missing).toContain("Curiosity Gaps");
      expect(result.missing).toContain("Emerging Skills");
    });

    it("should fail for empty content", () => {
      const result = validateWorkingMemory("");
      expect(result.valid).toBe(false);
      expect(result.missing.length).toBe(7);
    });

    it("should warn about malformed Crystal Pointers", () => {
      const content = WORKING_MEMORY_SECTIONS.map((s) => {
        if (s === "Crystal Pointers") {
          return `## ${s}\n- Good pointer → search: \`keywords here\`\n- Bad pointer → missing backtick format`;
        }
        return `## ${s}\nContent`;
      }).join("\n\n");
      const result = validateWorkingMemory(content);
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain("Crystal Pointer");
    });

    it("should not warn about well-formed Crystal Pointers", () => {
      const content = WORKING_MEMORY_SECTIONS.map((s) => {
        if (s === "Crystal Pointers") {
          return `## ${s}\n- CORS debugging → search: \`CORS P2P EigenTrust\`\n- WSL migration → search: \`workspace WSL path\``;
        }
        return `## ${s}\nContent`;
      }).join("\n\n");
      const result = validateWorkingMemory(content);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([]);
    });
  });

  describe("validateWorkingMemory collapse guards", () => {
    const validContent = [
      "# Working Memory State",
      "## The Phenotype",
      "Agent identity: curious, technical, developing expertise in memory systems",
      "## The Bond",
      "User: Vic, neuroscientist, casual style, prefers clean TypeScript",
      "## The Niche",
      "Published skills: none yet. Pre-network phase.",
      "## Active Context",
      "Working on memory pipeline audit. Recent breakthrough with biological identity system.",
      "## Crystal Pointers",
      "- Legacy memory system → search: `legacy memory system`",
      "- GCCRF implementation → search: `GCCRF implementation`",
      "## Curiosity Gaps",
      "- Investigate dream engine LLM mode effectiveness",
      "## Emerging Skills",
      "- Task prioritization → Confidence: 80%",
    ].join("\n");

    const longPreviousContent = validContent + "\n" + "Additional context detail. ".repeat(200);

    it("accepts valid content with no previous state", () => {
      const result = validateWorkingMemory(validContent);
      expect(result.valid).toBe(true);
      expect(result.collapsed).toBe(false);
    });

    it("accepts valid content when similar length to previous", () => {
      const result = validateWorkingMemory(validContent, validContent);
      expect(result.valid).toBe(true);
      expect(result.collapsed).toBe(false);
    });

    it("rejects mass drop — new state <50% of mature previous state", () => {
      const result = validateWorkingMemory(validContent, longPreviousContent);
      expect(result.collapsed).toBe(true);
      expect(result.collapseReason).toContain("Mass drop");
    });

    it("allows mass drop when previous state is immature (<2000 chars)", () => {
      const shortPrevious = validContent; // ~400 chars
      // Build a shorter new state that has enough substance to not trigger empty synthesis
      const shorterNew = WORKING_MEMORY_SECTIONS.map((s) =>
        `## ${s}\nSome meaningful content for this section that is substantive enough.`,
      ).join("\n");
      const result = validateWorkingMemory(shorterNew, shortPrevious);
      // Should NOT collapse because previous is <2000 chars (mass drop guard ignores immature states)
      expect(result.collapsed).toBe(false);
    });

    it("rejects eviction runaway — >20 crystal pointers", () => {
      const manyPointers = Array.from({ length: 25 }, (_, i) =>
        `- Topic ${i} → search: \`topic ${i}\``,
      ).join("\n");
      const runawayContent = validContent.replace(
        "- Legacy memory system → search: `legacy memory system`\n- GCCRF implementation → search: `GCCRF implementation`",
        manyPointers,
      );
      const result = validateWorkingMemory(runawayContent);
      expect(result.collapsed).toBe(true);
      expect(result.collapseReason).toContain("Eviction runaway");
    });

    it("rejects empty synthesis — headers only, no substance", () => {
      const headersOnly = WORKING_MEMORY_SECTIONS.map((s) => `## ${s}\n`).join("\n");
      const result = validateWorkingMemory(headersOnly);
      expect(result.collapsed).toBe(true);
      expect(result.collapseReason).toContain("Empty synthesis");
    });
  });
});
