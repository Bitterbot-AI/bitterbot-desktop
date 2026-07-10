/**
 * PLAN-33 Phase 1 — end-to-end acceptance test (the incident, mechanized).
 *
 * Boots the REAL MemoryIndexManager (embeddings/chokidar/sqlite-vec mocked,
 * same harness as manager.get-dedupe.test.ts), pins the repo fact through the
 * real memory_pin tool, and asserts resolveCanonicalFactsBlock — the exact
 * function every runner calls during system-prompt assembly — returns a block
 * containing the exact repo string, with no user message, no embedding match,
 * and no hormonal state involved. This is the cold-start guarantee the whole
 * plan exists to provide; if this test fails, the 2026-07-10 repo
 * misidentification can happen again.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedBatch: async () => [],
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

import { resolveCanonicalFactsBlock } from "../agents/canonical-facts-block.js";
import { createMemoryPinTool } from "../agents/tools/memory-tool.js";
import { getMemorySearchManager } from "./index.js";

const REPO = "github.com/Bitterbot-AI/bitterbot-desktop";
let fixtureRoot: string;
let cfg: Record<string, unknown>;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-canonical-e2e-"));
  const workspaceDir = path.join(fixtureRoot, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          store: { path: path.join(fixtureRoot, "index.sqlite"), vector: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
});

afterAll(async () => {
  const { manager } = await getMemorySearchManager({ cfg, agentId: "main" });
  await manager?.close?.();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("canonical ledger end-to-end (real manager, real tool, real resolver)", () => {
  it("a pinned fact reaches the prompt block deterministically on a cold path", async () => {
    // 1. Pin through the real tool, exactly as the agent would.
    const tool = createMemoryPinTool({ config: cfg });
    expect(tool).not.toBeNull();
    const pinResult = await tool!.execute("pin_repo", {
      action: "pin",
      key: "project.repo",
      value: REPO,
      statement: `The project repository is ${REPO}.`,
      category: "project",
    });
    expect((pinResult.details as { ok: boolean }).ok).toBe(true);

    // 2. Resolve the block the way every runner does at prompt assembly —
    //    no user message, no embedding, no hormones anywhere in this path.
    const block = await resolveCanonicalFactsBlock({ config: cfg, agentId: "main" });
    expect(block).toContain("## Canonical Facts");
    expect(block).toContain(REPO); // exact string, never paraphrased

    // 3. Minimal (subagent) mode still carries project + identity categories.
    const minimal = await resolveCanonicalFactsBlock({
      config: cfg,
      agentId: "main",
      promptMode: "minimal",
    });
    expect(minimal).toContain(REPO);

    // 4. Deterministic across repeated cold resolutions.
    for (let i = 0; i < 5; i++) {
      const again = await resolveCanonicalFactsBlock({ config: cfg, agentId: "main" });
      expect(again).toContain(REPO);
    }

    // 5. Re-pinning the same value strengthens instead of duplicating.
    const again = await tool!.execute("pin_repo_2", {
      action: "pin",
      key: "project.repo",
      value: REPO,
    });
    expect((again.details as { op: string }).op).toBe("strengthen");

    // 6. The kill switch actually kills it.
    const disabledCfg = { ...cfg, memory: { canonicalLedger: { enabled: false } } };
    expect(createMemoryPinTool({ config: disabledCfg })).toBeNull();
    const disabledBlock = await resolveCanonicalFactsBlock({
      config: disabledCfg,
      agentId: "main",
    });
    expect(disabledBlock).toBeUndefined();

    // 7. Observability: the injection registered in retrievalHealth.
    const { manager } = await getMemorySearchManager({ cfg, agentId: "main" });
    const health = (
      manager as unknown as {
        retrievalHealth(): {
          canonical: { activeFacts: number; lastInjection: { count: number } | null } | null;
        };
      }
    ).retrievalHealth();
    expect(health.canonical?.activeFacts).toBeGreaterThan(0);
    expect(health.canonical?.lastInjection?.count).toBeGreaterThan(0);
  }, 60_000);
});
