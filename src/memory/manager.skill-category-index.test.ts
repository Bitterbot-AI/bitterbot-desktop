/**
 * Audit F12, remaining path: SKILL.md files indexed from disk land as
 * source='skills' chunks that the liveness check counts as skill crystals.
 * 487 of them carried no skill_category on the live node — invisible to
 * skills.metrics for exactly the same reason the v57-fixed creation paths
 * were. The containing folder is the canonical key (the bootstrap's rule).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));
vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "disabled in tests" }),
  probeSqliteVec: async () => ({ ok: false, error: "disabled in tests" }),
}));
vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedBatch: async (t: string[]) => t.map(() => [0.1, 0.2, 0.3]),
    },
    openAi: { baseUrl: "x", headers: {}, model: "text-embedding-3-small" },
  }),
}));

let root: string | null = null;
afterEach(async () => {
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = null;
  }
});

describe("skillCategoryFromPath via indexed SKILL.md", () => {
  it("stamps the folder name as skill_category on indexed skill chunks", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-skillcat-"));
    const workspaceDir = path.join(root, "ws");
    const skillsDir = path.join(workspaceDir, "skills", "docker-deploy");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, "SKILL.md"),
      "---\nname: docker-deploy\n---\nDeploy containers reliably with retries.\n",
      "utf-8",
    );

    const { manager } = await getMemorySearchManager({
      cfg: {
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              provider: "openai",
              model: "text-embedding-3-small",
              sources: ["memory", "skills"],
              store: { path: path.join(root, "idx.sqlite"), vector: { enabled: false } },
              sync: { watch: false, onSessionStart: false, onSearch: false },
              query: { minScore: 0, hybrid: { enabled: false } },
            },
          },
          list: [{ id: "main", default: true }],
        },
      } as never,
      agentId: "main",
    });
    expect(manager).not.toBeNull();
    const mgr = manager as unknown as MemoryIndexManager & {
      sync: (o?: unknown) => Promise<unknown>;
    };
    await mgr.sync({ force: true });

    const db = (mgr as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const rows = db
      .prepare(`SELECT skill_category FROM chunks WHERE source = 'skills'`)
      .all() as Array<{ skill_category: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.skill_category === "docker-deploy")).toBe(true);
    await manager?.close();
  });
});
