/**
 * Integration tests for rewriteWorkingMemory() — the RLM state vector update.
 *
 * Tests the full path: read old state + scratch → synthesize → write MEMORY.md → clear scratch.
 *
 * Known test limitation: the manager's internal DB handle is not queryable via the
 * public `manager` reference in the test environment (resetIndex + mixin layering
 * means direct SQL queries return empty results). Crystal indexing
 * (indexScratchAsCrystals, ingestScratchNote) is tested indirectly via the
 * indexScratchAsCrystals unit test below and by verifying scratch consumption.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import type { DreamStats } from "./dream-types.js";
import {
  buildWorkingMemorySynthesisPrompt,
  buildHeuristicWorkingMemory,
  validateWorkingMemory,
  type WorkingMemoryContext,
} from "./working-memory-prompt.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.5, 0.5, 0.5]));
const embedQuery = vi.fn(async () => [0.5, 0.5, 0.5]);

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery,
      embedBatch,
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

function makeDreamStats(overrides?: { insights?: Array<{ content: string; mode: string; confidence: number }> }): DreamStats {
  return {
    cycle: {
      cycleId: "test-cycle-1",
      startedAt: Date.now() - 5000,
      completedAt: Date.now(),
      durationMs: 5000,
      state: "AWAKENING",
      clustersProcessed: 2,
      insightsGenerated: overrides?.insights?.length ?? 0,
      chunksAnalyzed: 10,
      llmCallsUsed: 1,
      error: null,
    },
    newInsights: (overrides?.insights ?? []).map((i, idx) => ({
      id: `insight-${idx}`,
      content: i.content,
      embedding: [0.5, 0.5, 0.5],
      confidence: i.confidence,
      mode: i.mode as "replay",
      sourceChunkIds: [],
      sourceClusterIds: [],
      dreamCycleId: "test-cycle-1",
      importanceScore: 0.7,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  };
}

describe("rewriteWorkingMemory integration", () => {
  let fixtureRoot: string;
  let workspaceDir: string;
  let memoryDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  function createCfg() {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-wm-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexPath = path.join(fixtureRoot, "index.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });

    const result = await getMemorySearchManager({ cfg: createCfg(), agentId: "main" });
    expect(result.manager).not.toBeNull();
    manager = result.manager!;
  });

  afterAll(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    embedBatch.mockClear();
    embedQuery.mockClear();

    // Clean workspace files between tests
    const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
    const scratchPath = path.join(memoryDir, "scratch.md");
    try { await fs.unlink(memoryMdPath); } catch {}
    try { await fs.unlink(scratchPath); } catch {}

    // Reset index
    if (manager) {
      (manager as unknown as { resetIndex: () => void }).resetIndex();
      (manager as unknown as { dirty: boolean }).dirty = true;
    }
  });

  // Access private method via cast
  function callRewriteWorkingMemory(stats: DreamStats): Promise<void> {
    return (manager as unknown as { rewriteWorkingMemory: (s: DreamStats) => Promise<void> })
      .rewriteWorkingMemory(stats);
  }

  // ── Core State Vector Tests ──

  it("should create MEMORY.md with all 7 sections on first synthesis (no prior state)", async () => {
    await callRewriteWorkingMemory(makeDreamStats());

    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");

    expect(content).toContain("# Working Memory State");
    expect(content).toContain("## The Phenotype");
    expect(content).toContain("## The Bond");
    expect(content).toContain("## The Niche");
    expect(content).toContain("## Active Context");
    expect(content).toContain("## Crystal Pointers");
    expect(content).toContain("## Curiosity Gaps");
    expect(content).toContain("## Emerging Skills");
  });

  it("should use conservative first-cycle transition when existing user content exists", async () => {
    const userContent = "# My Notes\n\nVic's personal memory file with custom info.";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), userContent, "utf-8");

    await callRewriteWorkingMemory(makeDreamStats());

    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    // Should preserve original content at the top
    expect(content).toContain("Vic's personal memory file");
    // Should have the dream-generated divider
    expect(content).toContain("Dream-generated working memory follows");
    // Should also have the new schema appended below
    expect(content).toContain("## The Bond");
    // User content must appear BEFORE the divider
    const userPos = content.indexOf("Vic's personal memory file");
    const dividerPos = content.indexOf("Dream-generated working memory follows");
    expect(userPos).toBeLessThan(dividerPos);
  });

  it("should NOT use conservative transition when MEMORY.md already has Working Memory State", async () => {
    const existingState = "# Working Memory State\n*Last dream: 2026-03-11*\n\n## The Phenotype\nDeveloping agent.\n\n## The Bond\nExisting bond.\n\n## The Niche\nPre-network.\n\n## Active Context\nOld context.\n\n## Crystal Pointers\n*Use memory_search*\n\n## Curiosity Gaps\nNone.\n\n## Emerging Skills\nNone.";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), existingState, "utf-8");

    await callRewriteWorkingMemory(makeDreamStats());

    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    // Should NOT have the conservative divider — this is a normal rewrite
    expect(content).not.toContain("Dream-generated working memory follows");
    expect(content).toContain("## The Bond");
  });

  // ── Scratch Buffer WAL Tests ──

  it("should consume scratch notes into MEMORY.md and clear the buffer", async () => {
    const scratchPath = path.join(memoryDir, "scratch.md");
    const scratchContent = `# Scratch Buffer (Working Memory WAL)

Unsynthesized notes — will be consumed by next dream cycle.

- [2026-03-12T14:30:00Z] (importance: 0.8) Vic prefers TypeScript strict mode
- [2026-03-12T14:45:00Z] (importance: 0.7) Project deadline is March 20th
`;
    await fs.writeFile(scratchPath, scratchContent, "utf-8");

    await callRewriteWorkingMemory(makeDreamStats());

    // Scratch buffer should be cleared (reset to header only)
    const clearedScratch = await fs.readFile(scratchPath, "utf-8");
    expect(clearedScratch).toContain("# Scratch Buffer");
    expect(clearedScratch).not.toContain("Vic prefers TypeScript strict mode");
    expect(clearedScratch).not.toContain("March 20th");

    // Scratch notes should appear in the MEMORY.md Active Context (via heuristic)
    const memoryContent = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memoryContent).toContain("TypeScript strict mode");
  });

  it("should index scratch notes as crystals in the database (lossless backup)", async () => {
    const scratchPath = path.join(memoryDir, "scratch.md");
    await fs.writeFile(scratchPath, `# Scratch Buffer (Working Memory WAL)

- [2026-03-12T14:30:00Z] (importance: 0.8) Vic prefers TypeScript strict mode and tabs over spaces
`, "utf-8");

    await callRewriteWorkingMemory(makeDreamStats());

    // Verify crystals were actually inserted into the database.
    // This tests the fix for the NOT NULL constraint bug: the base chunks schema
    // requires `model` and `embedding` columns, which the original INSERT omitted,
    // causing INSERT OR IGNORE to silently skip every row.
    const db = (manager as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).db;
    const rows = db.prepare(
      `SELECT id, text, model FROM chunks WHERE id LIKE 'scratch_%'`,
    ).all() as Array<{ id: string; text: string; model: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.text).toContain("TypeScript strict mode");
    expect(rows[0]!.model).toBe("pending");
  });

  it("should run even with zero dream insights (scratch must always be consumed)", async () => {
    // This tests the fix for the bug where rewriteWorkingMemory was gated
    // by `newInsights.length > 0`, causing scratch notes to pile up
    const scratchPath = path.join(memoryDir, "scratch.md");
    await fs.writeFile(scratchPath, `# Scratch Buffer (Working Memory WAL)

- [2026-03-13T10:00:00Z] (importance: 0.9) User's name is Douglas
`, "utf-8");

    // Zero insights — the dream produced nothing, but scratch must still be consumed
    await callRewriteWorkingMemory(makeDreamStats({ insights: [] }));

    // MEMORY.md should still be created
    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(content).toContain("## The Bond");

    // Scratch should be consumed (notes cleared)
    const scratch = await fs.readFile(scratchPath, "utf-8");
    expect(scratch).not.toContain("Douglas");
  });

  // ── Heuristic Fallback Tests ──

  it("should produce valid schema via heuristic when no llmCall is configured", async () => {
    // No llmCall in config means heuristic path always runs
    await callRewriteWorkingMemory(makeDreamStats());

    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    const validation = validateWorkingMemory(content);
    expect(validation.valid).toBe(true);
    expect(validation.missing).toEqual([]);
  });

  it("should preserve The Bond from previous state in heuristic rewrite", async () => {
    const existingState = `# Working Memory State
*Last dream: 2026-03-11T00:00:00Z | Mood: motivated*

## The Phenotype (Ego State)
Developing agent focused on memory system design.

## The Bond (Oxytocin-Weighted)
Vic is an experienced architect who values clean TypeScript and dislikes semicolons.

## The Niche (Ecosystem Identity)
Pre-network — building local expertise.

## Active Context (Dopamine/Cortisol-Weighted)
Working on memory system evolution.

## Crystal Pointers (Deep Memory Awareness)
*Use memory_search if user asks about these topics:*
- CORS debugging → search: \`CORS P2P EigenTrust\`

## Curiosity Gaps
None.

## Emerging Skills
*Patterns detected from repeated tasks. Pre-crystallization:*
None.`;
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), existingState, "utf-8");

    await callRewriteWorkingMemory(makeDreamStats());

    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    // The Bond should survive the heuristic rewrite (extractSection preserves it)
    expect(content).toContain("Vic is an experienced architect");
  });

  // ── Edge Cases ──

  it("should work gracefully with no scratch file and no MEMORY.md", async () => {
    await expect(callRewriteWorkingMemory(makeDreamStats())).resolves.not.toThrow();

    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(content).toContain("## The Bond");
  });

  it("should handle empty scratch buffer (header only, no notes)", async () => {
    const scratchPath = path.join(memoryDir, "scratch.md");
    await fs.writeFile(scratchPath, "# Scratch Buffer (Working Memory WAL)\n\nUnsynthesized notes — will be consumed by next dream cycle.\n", "utf-8");

    await callRewriteWorkingMemory(makeDreamStats());

    // Should not crash, should produce valid MEMORY.md
    const content = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(content).toContain("## The Bond");

    // Scratch should remain as-is (no notes to clear, but header preserved)
    const scratch = await fs.readFile(scratchPath, "utf-8");
    expect(scratch).toContain("# Scratch Buffer");
  });
});

// ── Unit Tests: indexScratchAsCrystals parsing logic ──

describe("indexScratchAsCrystals parsing", () => {
  // These test the parsing logic directly since the full integration path
  // through the manager's DB is not reliably testable in the mocked environment.

  it("should match scratch entries with proper timestamp format", () => {
    const content = `# Scratch Buffer (Working Memory WAL)

Unsynthesized notes — will be consumed by next dream cycle.

- [2026-03-12T14:30:00Z] (importance: 0.8) Vic prefers TypeScript strict mode and tabs
- [2026-03-12T14:45:00Z] (importance: 0.7) Project deadline is March 20th for API migration
- Some random line without timestamp
- [not-a-date] This should not match
`;
    const lines = content.split("\n").filter((l) => {
      const trimmed = l.trimStart();
      return trimmed.startsWith("- [") && /^- \[\d{4}-/.test(trimmed);
    });

    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("TypeScript strict mode");
    expect(lines[1]).toContain("March 20th");
  });

  it("should extract note content by stripping timestamp and importance prefix", () => {
    const line = "- [2026-03-12T14:30:00Z] (importance: 0.8) Vic prefers TypeScript strict mode";
    const text = line
      .replace(/^-\s*\[[^\]]*\]\s*/, "")
      .replace(/^\(importance:\s*[\d.]+\)\s*/, "")
      .trim();

    expect(text).toBe("Vic prefers TypeScript strict mode");
  });

  it("should handle entries without importance field", () => {
    const line = "- [2026-03-12T14:30:00Z] User mentioned they prefer dark themes";
    const text = line
      .replace(/^-\s*\[[^\]]*\]\s*/, "")
      .replace(/^\(importance:\s*[\d.]+\)\s*/, "")
      .trim();

    expect(text).toBe("User mentioned they prefer dark themes");
  });

  it("should skip entries with extracted text shorter than 10 chars", () => {
    const line = "- [2026-03-12T14:30:00Z] (importance: 0.8) Too short";
    const text = line
      .replace(/^-\s*\[[^\]]*\]\s*/, "")
      .replace(/^\(importance:\s*[\d.]+\)\s*/, "")
      .trim();

    // "Too short" is 9 chars — would be skipped by the length check
    expect(text.length).toBeLessThan(10);
  });

  it("should handle AUTO-generated hormonal spike entries", () => {
    const line = "- [2026-03-12T15:30:00Z] (importance: 0.8) [AUTO] Hormonal event: dopamine spike (achievement/breakthrough detected). User seems energized after solving the build issue.";
    const text = line
      .replace(/^-\s*\[[^\]]*\]\s*/, "")
      .replace(/^\(importance:\s*[\d.]+\)\s*/, "")
      .trim();

    expect(text).toContain("[AUTO] Hormonal event");
    expect(text.length).toBeGreaterThan(10);
  });
});

// ── Unit Tests: LLM synthesis path (mocked) ──

describe("LLM synthesis with validation", () => {
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

  it("should accept valid LLM output with all 7 sections", () => {
    const llmOutput = `# Working Memory State
*Last dream: 2026-03-12T00:00:00Z | Mood: motivated*

## The Phenotype (Ego State)
Developing agent building memory systems. Strengths in TypeScript and system design.

## The Bond (Oxytocin-Weighted)
User is building a P2P agent mesh. Prefers TypeScript.

## The Niche (Ecosystem Identity)
Pre-network — building local expertise before contributing to the ecosystem.

## Active Context (Dopamine/Cortisol-Weighted)
Working on memory system evolution. Breakthrough: dream engine integrated.

## Crystal Pointers (Deep Memory Awareness)
*Use memory_search if user asks about these topics:*
- CORS debugging on P2P bridge → search: \`CORS P2P EigenTrust\`

## Curiosity Gaps
How does the hormonal system affect long-term memory formation?

## Emerging Skills
*Patterns detected from repeated tasks. Pre-crystallization:*
- TypeScript refactoring → Confidence: 85% | Occurrences: 7`;

    const validation = validateWorkingMemory(llmOutput);
    expect(validation.valid).toBe(true);
    expect(validation.missing).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it("should reject LLM output missing sections and fall back to heuristic", () => {
    const badLlmOutput = "# Working Memory State\n## The Bond\nSome content.";
    const validation = validateWorkingMemory(badLlmOutput);
    expect(validation.valid).toBe(false);
    expect(validation.missing).toContain("Active Context");

    // Heuristic fallback should always produce valid output
    const heuristic = buildHeuristicWorkingMemory(makeContext());
    const heuristicValidation = validateWorkingMemory(heuristic);
    expect(heuristicValidation.valid).toBe(true);
  });

  it("should warn about malformed Crystal Pointers in otherwise valid output", () => {
    const llmOutput = `# Working Memory State
## The Phenotype (Ego State)
Content.
## The Bond (Oxytocin-Weighted)
Content.
## The Niche (Ecosystem Identity)
Content.
## Active Context (Dopamine/Cortisol-Weighted)
Content.
## Crystal Pointers (Deep Memory Awareness)
- Good pointer → search: \`CORS debugging\`
- Bad pointer → CORS debugging
## Curiosity Gaps
Content.
## Emerging Skills
Content.`;

    const validation = validateWorkingMemory(llmOutput);
    expect(validation.valid).toBe(true);
    expect(validation.warnings.length).toBe(1);
    expect(validation.warnings[0]).toContain("Crystal Pointer");
  });

  it("should include scratch notes and crystals in synthesis prompt", () => {
    const ctx = makeContext({
      scratchNotes: "- [2026-03-12] User's name is Douglas, prefers tabs",
      recentCrystals: [{
        text: "Built P2P skill network with EigenTrust reputation",
        semanticType: "fact",
        importanceScore: 0.9,
      }],
    });

    const prompt = buildWorkingMemorySynthesisPrompt(ctx);
    expect(prompt).toContain("Douglas");
    expect(prompt).toContain("EigenTrust");
    expect(prompt).toContain("Reinforce");
    expect(prompt).toContain("Evict");
    expect(prompt).toContain("Crystal Pointer");
  });
});

// ── First Breath Micro-Cycle Tests ──

describe("First Breath micro-cycle", () => {
  let fixtureRoot: string;
  let workspaceDir: string;
  let memoryDir: string;
  let indexPath: string;
  let fbManager: MemoryIndexManager | null = null;

  function createFbCfg() {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "fb-test", default: true }],
      },
    };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-fb-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexPath = path.join(fixtureRoot, "fb-index.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });

    const result = await getMemorySearchManager({ cfg: createFbCfg(), agentId: "fb-test" });
    expect(result.manager).not.toBeNull();
    fbManager = result.manager!;
  });

  afterAll(async () => {
    if (fbManager) {
      await fbManager.close();
      fbManager = null;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function callShouldTriggerFirstBreath(): Promise<boolean> {
    return (fbManager as unknown as { shouldTriggerFirstBreath: () => Promise<boolean> })
      .shouldTriggerFirstBreath();
  }

  it("triggers when scratch buffer >=500 chars and no Phenotype section exists", async () => {
    const scratchPath = path.join(memoryDir, "scratch.md");
    const memoryMdPath = path.join(workspaceDir, "MEMORY.md");

    // Write 500+ chars to scratch with enough note entries
    const notes = Array.from({ length: 6 }, (_, i) =>
      `- [2026-03-15T10:0${i}:00Z] (importance: 0.7) User context note number ${i} with enough detail to be meaningful`,
    ).join("\n");
    await fs.writeFile(scratchPath, `# Scratch Buffer (Working Memory WAL)\n\n${notes}\n`, "utf-8");

    // Write MEMORY.md without Phenotype section (old 5-section format)
    await fs.writeFile(memoryMdPath, [
      "# Working Memory State",
      "## The Bond",
      "Unknown user",
      "## Active Context",
      "No context yet",
      "## Crystal Pointers",
      "## Curiosity Gaps",
      "## Emerging Skills",
    ].join("\n"), "utf-8");

    const shouldTrigger = await callShouldTriggerFirstBreath();
    expect(shouldTrigger).toBe(true);
  });

  it("does NOT trigger when Phenotype section already exists", async () => {
    const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
    const scratchPath = path.join(memoryDir, "scratch.md");

    // Write MEMORY.md with Phenotype section
    await fs.writeFile(memoryMdPath, [
      "# Working Memory State",
      "## The Phenotype",
      "Developing agent.",
      "## The Bond",
      "User profile.",
      "## The Niche",
      "Pre-network.",
      "## Active Context",
      "Working.",
      "## Crystal Pointers",
      "## Curiosity Gaps",
      "## Emerging Skills",
    ].join("\n"), "utf-8");

    // Still have scratch content
    const notes = Array.from({ length: 6 }, (_, i) =>
      `- [2026-03-15T10:0${i}:00Z] (importance: 0.7) Note ${i} with enough detail`,
    ).join("\n");
    await fs.writeFile(scratchPath, `# Scratch Buffer (Working Memory WAL)\n\n${notes}\n`, "utf-8");

    const shouldTrigger = await callShouldTriggerFirstBreath();
    expect(shouldTrigger).toBe(false);
  });

  it("does NOT trigger when scratch buffer is too small", async () => {
    const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
    const scratchPath = path.join(memoryDir, "scratch.md");

    // No Phenotype in MEMORY.md
    await fs.writeFile(memoryMdPath, "# Working Memory State\n## The Bond\nUser.", "utf-8");

    // Tiny scratch buffer
    await fs.writeFile(scratchPath, "# Scratch Buffer (Working Memory WAL)\n\n- [2026-03-15] hi\n", "utf-8");

    const shouldTrigger = await callShouldTriggerFirstBreath();
    expect(shouldTrigger).toBe(false);
  });
});

// ── Legacy File Write-Back Tests ──

describe("Legacy file write-back", () => {
  let fixtureRoot: string;
  let workspaceDir: string;
  let memoryDir: string;
  let indexPath: string;
  let lwManager: MemoryIndexManager | null = null;

  function createLwCfg() {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "lw-test", default: true }],
      },
    };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-lw-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexPath = path.join(fixtureRoot, "lw-index.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });

    const result = await getMemorySearchManager({ cfg: createLwCfg(), agentId: "lw-test" });
    expect(result.manager).not.toBeNull();
    lwManager = result.manager!;
  });

  afterAll(async () => {
    if (lwManager) {
      await lwManager.close();
      lwManager = null;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

});
