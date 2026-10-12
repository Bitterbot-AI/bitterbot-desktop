import { describe, it, expect, vi } from "vitest";
import {
  buildWorkingMemorySynthesisPrompt,
  synthesizeValidatedWorkingMemory,
  applyCrystalPointerRepair,
  MAX_CRYSTAL_POINTERS,
  buildHeuristicWorkingMemory,
  stripSectionSubheaders,
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
        makeContext({
          hormonalState: { dopamine: 0.8, cortisol: 0.1, oxytocin: 0.6, mood: "energized" },
        }),
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
          recentCrystals: [
            {
              text: "User is building a P2P agent system",
              semanticType: "fact",
              importanceScore: 0.9,
            },
          ],
        }),
      );
      expect(prompt).toContain("P2P agent system");
    });

    it("should include dream insights", () => {
      const prompt = buildWorkingMemorySynthesisPrompt(
        makeContext({
          dreamInsights: [
            {
              content: "Cross-domain connection between CORS and EigenTrust",
              mode: "simulation",
              confidence: 0.85,
            },
          ],
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
          curiosityTargets: [
            { description: "How does the P2P bridge handle NAT traversal?", priority: 0.8 },
          ],
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
      expect(result).toContain("2026-03-12");
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
      const shorterNew = WORKING_MEMORY_SECTIONS.map(
        (s) => `## ${s}\nSome meaningful content for this section that is substantive enough.`,
      ).join("\n");
      const result = validateWorkingMemory(shorterNew, shortPrevious);
      // Should NOT collapse because previous is <2000 chars (mass drop guard ignores immature states)
      expect(result.collapsed).toBe(false);
    });

    it("rejects eviction runaway — >20 crystal pointers", () => {
      const manyPointers = Array.from(
        { length: 25 },
        (_, i) => `- Topic ${i} → search: \`topic ${i}\``,
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

describe("buildHeuristicWorkingMemory idempotence (token-efficiency pass 2026-09-19)", () => {
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("running the heuristic on its own output does not grow it or duplicate sub-headers", () => {
    const first = buildHeuristicWorkingMemory(
      makeContext({
        userPreferences: [{ category: "identity", key: "name", value: "Victor" }],
        curiosityTargets: [{ description: "learn zig", type: "frontier", priority: 0.5 }],
      } as Partial<WorkingMemoryContext>),
    );
    const second = buildHeuristicWorkingMemory(makeContext({ oldState: first }));
    const third = buildHeuristicWorkingMemory(makeContext({ oldState: second }));
    expect(third.length).toBe(second.length);
    expect(count(third, "*Who am I becoming?*")).toBe(1);
    expect(count(third, "*Who is the user, and how do we relate?*")).toBe(1);
    expect(count(third, "*What is my role in the network?*")).toBe(1);
    expect(count(third, "*Use memory_search if user asks about these topics:*")).toBe(1);
    expect(third).toContain("Victor");
  });

  it("repairs a MEMORY.md already polluted with repeated sub-headers", () => {
    const polluted = buildHeuristicWorkingMemory(makeContext()).replace(
      "*Who am I becoming?*\n",
      "*Who am I becoming?*\n".repeat(21),
    );
    expect(count(polluted, "*Who am I becoming?*")).toBe(21);
    const repaired = buildHeuristicWorkingMemory(makeContext({ oldState: polluted }));
    expect(count(repaired, "*Who am I becoming?*")).toBe(1);
  });

  it("stripSectionSubheaders also drops the LLM-schema variant with the parenthetical", () => {
    expect(
      stripSectionSubheaders(
        "*Who am I becoming? (Dopamine/Cortisol-weighted — achievements shape self-concept)*\nI am curious.",
      ),
    ).toBe("I am curious.");
    expect(stripSectionSubheaders(null)).toBeNull();
    expect(stripSectionSubheaders("*Who am I becoming?*")).toBeNull();
  });
});

describe("bounded synthesis repair", () => {
  const document = (count: number) =>
    WORKING_MEMORY_SECTIONS.map(
      (section) =>
        `## ${section}\n` +
        (section === "Crystal Pointers"
          ? Array.from({ length: count }, (_, i) => `- Topic ${i} → search: \`topic ${i}\``).join(
              "\n",
            )
          : "Meaningful ongoing context and established user preferences remain available."),
    ).join("\n\n");

  it("states the same pointer limit enforced by validation", () => {
    expect(buildWorkingMemorySynthesisPrompt(makeContext())).toContain(
      `at most ${MAX_CRYSTAL_POINTERS} bullet entries total`,
    );
    expect(validateWorkingMemory(document(20)).collapsed).toBe(false);
    expect(validateWorkingMemory(document(21)).collapsed).toBe(true);
  });

  it("accepts valid synthesis without an extra model call", async () => {
    const call = vi.fn().mockResolvedValue(document(20));
    const result = await synthesizeValidatedWorkingMemory(makeContext(), call);
    expect(result.attempts).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("repairs overflow once and validates the corrected document", async () => {
    const merged = Array.from(
      { length: 20 },
      (_, i) => `- Topic ${i} → search: \`topic ${i}${i === 0 ? "; topic 20" : ""}\``,
    );
    const call = vi
      .fn()
      .mockResolvedValueOnce(document(21))
      .mockResolvedValueOnce(JSON.stringify(merged));
    const result = await synthesizeValidatedWorkingMemory(makeContext(), call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toContain("at most 16 pointer entries");
    expect(call.mock.calls[1][0]).toContain("Preserve EVERY original search-query phrase");
    expect(result.raw).toContain("topic 0; topic 20");
    expect(result.validation.collapsed).toBe(false);
    expect(result.validation.valid).toBe(true);
  });

  it("does not loop or truncate if repair still exceeds the limit", async () => {
    const call = vi.fn().mockResolvedValue(document(21));
    const result = await synthesizeValidatedWorkingMemory(makeContext(), call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.raw).toBe(document(21));
    expect(result.validation.collapsed).toBe(true);
  });

  it("checks repaired output against the original mature state", async () => {
    const oldState = document(20) + "\nSubstantive historical details. ".repeat(250);
    const call = vi.fn().mockResolvedValueOnce(document(21)).mockResolvedValueOnce(document(1));
    const result = await synthesizeValidatedWorkingMemory(makeContext({ oldState }), call);
    expect(result.validation.collapsed).toBe(true);
    expect(result.validation.collapseReason).toContain("Mass drop");
  });

  it("repairs missing sections but propagates transport failures", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce("Incomplete draft")
      .mockResolvedValueOnce(document(2));
    expect((await synthesizeValidatedWorkingMemory(makeContext(), call)).validation.valid).toBe(
      true,
    );
    const failed = vi.fn().mockRejectedValue(new Error("transport unavailable"));
    await expect(synthesizeValidatedWorkingMemory(makeContext(), failed)).rejects.toThrow(
      "transport unavailable",
    );
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it("rejects lost phrases, over-limit arrays and malformed repair output", () => {
    const source = document(21);
    const tooMany = Array.from({ length: 21 }, (_, i) => `- Topic ${i} → search: \`topic ${i}\``);
    expect(applyCrystalPointerRepair(source, JSON.stringify(tooMany))).toBeNull();
    expect(applyCrystalPointerRepair(source, JSON.stringify(tooMany.slice(0, 20)))).toBeNull();
    expect(applyCrystalPointerRepair(source, "not json")).toBeNull();
    expect(
      applyCrystalPointerRepair(source, JSON.stringify(["- Missing search syntax"])),
    ).toBeNull();
    expect(
      applyCrystalPointerRepair(
        source,
        JSON.stringify(["## Injected header\n- Other → search: `topic`"]),
      ),
    ).toBeNull();
  });

  it("preserves every other section and every query phrase verbatim", () => {
    const source = document(21);
    const all = Array.from({ length: 21 }, (_, i) => `topic ${i}`).join("; ");
    const merged = applyCrystalPointerRepair(
      source,
      JSON.stringify([`- Related topics → search: \`${all}\``]),
    );
    expect(merged).not.toBeNull();
    const pattern = /## Crystal Pointers[^\n]*\n[\s\S]*?(?=\n## |$)/;
    expect(merged!.replace(pattern, "")).toBe(source.replace(pattern, ""));
    for (let i = 0; i < 21; i++) expect(merged).toContain(`topic ${i}`);
    expect(validateWorkingMemory(merged!).collapsed).toBe(false);
  });

  it("does not mistake a longer query for a preserved shorter query", () => {
    const source = document(2);
    expect(
      applyCrystalPointerRepair(source, JSON.stringify(["- Topics → search: `topic 0; topic 10`"])),
    ).toBeNull();
  });
  it("normalizes separate quoted phrases without losing query text", () => {
    const source = document(2);
    const response = JSON.stringify(["- Related topics → search: `topic 0`; `topic 1`"]);
    const repaired = applyCrystalPointerRepair(source, response);
    expect(repaired).toContain("- Related topics → search: `topic 0; topic 1`");
    expect(validateWorkingMemory(repaired!).collapsed).toBe(false);
  });
});
